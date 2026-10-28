import { CallHandler, ExecutionContext, HttpStatus, Injectable, NestInterceptor } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { catchError, from, mergeMap, Observable, of, throwError } from 'rxjs';
import { DbService, DbScope } from '../db/db.service';
import { AppException } from './errors';
import { RequestCtx } from './request-context';

const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;

/**
 * Honours the `Idempotency-Key` header on authenticated writes (POST/PUT/PATCH/DELETE).
 *  - first call: runs the handler and stores the result
 *  - same key + same request: replays the stored result (header `Idempotent-Replayed: true`), handler not run
 *  - same key + different request: 422 IDEMPOTENCY_KEY_REUSED
 *  - same key while the first call is still running: 409 IDEMPOTENCY_IN_PROGRESS
 * Failed calls release the key so the client can retry. Keys are per actor and expire after 24 h.
 * Must be registered INSIDE ResponseInterceptor so the stored value is the raw handler result.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private db: DbService) {}

  async intercept(ec: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = ec.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();
    const key = req.headers['idempotency-key'];
    const ctx: RequestCtx | undefined = req.ctx;
    if (key === undefined || !ctx || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next.handle();
    if (typeof key !== 'string' || !KEY.test(key)) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8-128 chars of [A-Za-z0-9_.:-]');
    }

    const scope: DbScope = ctx.kind === 'tenant' ? { tenantId: ctx.tenantId! } : { platform: true };
    const hash = createHash('sha256').update(`${req.method} ${req.originalUrl} ${JSON.stringify(req.body ?? null)}`).digest('hex');

    const state = await this.db.tx(scope, async (c) => {
      // expire old keys, and recover keys orphaned by a crash mid-request (>60 s in progress)
      await c.query(
        `DELETE FROM idempotency_keys WHERE actor_id = $1 AND key = $2
           AND (created_at < now() - interval '24 hours' OR (status = 'in_progress' AND created_at < now() - interval '60 seconds'))`,
        [ctx.userId, key]);
      const ins = await c.query(
        `INSERT INTO idempotency_keys (tenant_id, actor_id, key, request_hash) VALUES ($1,$2,$3,$4)
         ON CONFLICT (actor_id, key) DO NOTHING RETURNING id`,
        [ctx.tenantId ?? null, ctx.userId, key, hash]);
      if (ins.rowCount) return { kind: 'new' as const, id: ins.rows[0].id as string };
      const row = (await c.query('SELECT request_hash, status, response_status, response_body FROM idempotency_keys WHERE actor_id = $1 AND key = $2', [ctx.userId, key])).rows[0];
      if (row.request_hash !== hash) return { kind: 'mismatch' as const };
      if (row.status === 'completed') return { kind: 'replay' as const, status: row.response_status as number, body: row.response_body };
      return { kind: 'busy' as const };
    });

    if (state.kind === 'mismatch') throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request');
    if (state.kind === 'busy') throw new AppException(HttpStatus.CONFLICT, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed');
    if (state.kind === 'replay') {
      res.status(state.status);
      res.setHeader('Idempotent-Replayed', 'true');
      return of(state.body);
    }

    return next.handle().pipe(
      mergeMap((data) =>
        from(this.db.tx(scope, (c) => c.query(
          `UPDATE idempotency_keys SET status = 'completed', response_status = $2, response_body = $3 WHERE id = $1`,
          [state.id, res.statusCode, JSON.stringify(data ?? null)]))).pipe(mergeMap(() => of(data)))),
      catchError((e) =>
        from(this.db.tx(scope, (c) => c.query('DELETE FROM idempotency_keys WHERE id = $1', [state.id]))).pipe(mergeMap(() => throwError(() => e)))),
    );
  }
}
