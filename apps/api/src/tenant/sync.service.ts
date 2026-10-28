import { HttpStatus, Injectable } from '@nestjs/common';
import type { SyncEventInput } from '@rms/shared';
import { PoolClient } from 'pg';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors';
import { Page, PaginationQuery } from '../common/pagination';
import { RequestCtx } from '../common/request-context';

const MAX_BIGINT = 9223372036854775807n;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_PULL_CHANGES = 200;

@Injectable()
export class SyncService {
  constructor(private db: DbService, private audit: AuditService) {}

  private outletId(ctx: RequestCtx) {
    if (!ctx.outletId) throw new AppException(HttpStatus.BAD_REQUEST, 'OUTLET_REQUIRED', 'Select an outlet to sync');
    return ctx.outletId;
  }

  private async deviceForSession(c: PoolClient, ctx: RequestCtx, outletId: string) {
    const result = await c.query(
      `SELECT d.id, d.outlet_id AS "outletId"
         FROM sessions s JOIN devices d ON d.id = s.device_id
        WHERE s.id = $1 AND s.tenant_id = $2 AND s.user_id = $3 AND s.kind = 'tenant'
          AND s.revoked_at IS NULL AND d.status = 'active' AND d.deleted_at IS NULL`,
      [ctx.sessionId, ctx.tenantId, ctx.userId],
    );
    if (!result.rowCount) {
      throw new AppException(HttpStatus.FORBIDDEN, 'SYNC_DEVICE_REQUIRED', 'Sync requires an active session registered to a device');
    }
    if (result.rows[0].outletId !== outletId) {
      throw new AppException(HttpStatus.FORBIDDEN, 'SYNC_DEVICE_OUTLET_MISMATCH', 'The signed-in device is not registered to this outlet');
    }
    return result.rows[0] as { id: string; outletId: string };
  }

  async push(ctx: RequestCtx, events: SyncEventInput[]) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const device = await this.deviceForSession(c, ctx, outletId);
      await c.query('SELECT id FROM devices WHERE id = $1 FOR UPDATE', [device.id]);
      const results: Array<Record<string, unknown>> = [];
      let highestSequence = BigInt((await c.query(
        'SELECT COALESCE(max(device_seq),0)::text AS seq FROM sync_events WHERE device_id = $1',
        [device.id],
      )).rows[0].seq);
      for (const event of events) {
        const seq = BigInt(event.deviceSeq);
        const occurredAt = new Date(event.occurredAt);
        const payloadJson = JSON.stringify(event.payload);
        const payloadBytes = Buffer.byteLength(payloadJson, 'utf8');
        const now = new Date();
        const skewSeconds = Math.round((now.getTime() - occurredAt.getTime()) / 1000);
        if (seq > MAX_BIGINT) {
          results.push({ deviceSeq: event.deviceSeq, eventId: event.eventId, status: 'REJECTED', reason: 'DEVICE_SEQUENCE_TOO_LARGE' });
          continue;
        }
        if (!Number.isFinite(occurredAt.getTime()) || Math.abs(skewSeconds) > 2147483647) {
          results.push({ deviceSeq: event.deviceSeq, eventId: event.eventId, status: 'REJECTED', reason: 'INVALID_OCCURRED_AT' });
          continue;
        }
        if (!event.eventType.match(/^[A-Z][A-Z0-9_]{0,63}$/)) {
          results.push({ deviceSeq: event.deviceSeq, eventId: event.eventId, status: 'REJECTED', reason: 'INVALID_EVENT_TYPE' });
          continue;
        }
        if (payloadBytes > MAX_EVENT_BYTES) {
          results.push({ deviceSeq: event.deviceSeq, eventId: event.eventId, status: 'REJECTED', reason: 'PAYLOAD_TOO_LARGE' });
          continue;
        }

        const existing = await c.query(
          `SELECT event_id AS "eventId", device_seq::text AS "deviceSeq", event_type AS "eventType",
                  occurred_at AS "occurredAt", (payload = $4::jsonb) AS "payloadMatches"
             FROM sync_events
            WHERE device_id = $1 AND (device_seq = $2 OR event_id = $3)
            LIMIT 1`,
          [device.id, seq.toString(), event.eventId, payloadJson],
        );
        if (existing.rowCount) {
          const prior = existing.rows[0];
          const isExactReplay = prior.eventId === event.eventId && prior.deviceSeq === seq.toString()
            && prior.eventType === event.eventType
            && new Date(prior.occurredAt).getTime() === occurredAt.getTime()
            && prior.payloadMatches;
          results.push(isExactReplay
            ? { deviceSeq: event.deviceSeq, eventId: event.eventId, status: 'DUPLICATE' }
            : { deviceSeq: event.deviceSeq, eventId: event.eventId, status: 'REJECTED', reason: 'SEQUENCE_OR_EVENT_ID_CONFLICT' });
          continue;
        }
        if (seq <= highestSequence) {
          results.push({ deviceSeq: event.deviceSeq, eventId: event.eventId, status: 'REJECTED', reason: 'DEVICE_SEQUENCE_OUT_OF_ORDER' });
          continue;
        }
        const inserted = await c.query(
          `INSERT INTO sync_events
             (tenant_id, outlet_id, device_id, device_seq, event_id, event_type, occurred_at,
              clock_skew_seconds, payload, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [ctx.tenantId, outletId, device.id, seq.toString(), event.eventId, event.eventType,
            occurredAt.toISOString(), skewSeconds, payloadJson, ctx.userId],
        );
        if (!inserted.rowCount) {
          results.push({ deviceSeq: event.deviceSeq, eventId: event.eventId, status: 'REJECTED', reason: 'SEQUENCE_OR_EVENT_ID_CONFLICT' });
          continue;
        }
        highestSequence = seq;
        const clockSkewWarning = Math.abs(skewSeconds) > 300;
        await this.audit.log(c, {
          tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
          action: 'sync.event.receive', entity: 'sync_event', entityId: inserted.rows[0].id,
          meta: { deviceId: device.id, deviceSeq: seq.toString(), eventType: event.eventType, clockSkewWarning },
        });
        results.push({
          deviceSeq: event.deviceSeq, eventId: event.eventId, status: 'RECEIVED',
          clockSkewWarning,
        });
      }
      await c.query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [device.id]);
      return { serverTime: new Date().toISOString(), results };
    });
  }

  async pull(ctx: RequestCtx, since: string) {
    const outletId = this.outletId(ctx);
    if (BigInt(since) > MAX_BIGINT) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'SYNC_CURSOR_INVALID', 'Sync cursor exceeds the supported range');
    }
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const device = await this.deviceForSession(c, ctx, outletId);
      const { rows } = await c.query(
        `SELECT sequence::text AS sequence, entity_type AS "entityType", entity_id AS "entityId",
                payload, recorded_at AS "recordedAt"
           FROM sync_changes
          WHERE tenant_id = $1 AND (outlet_id = $2 OR outlet_id IS NULL) AND sequence > $3::bigint
          ORDER BY sequence LIMIT $4`,
        [ctx.tenantId, outletId, since, MAX_PULL_CHANGES + 1],
      );
      const hasMore = rows.length > MAX_PULL_CHANGES;
      const changes = rows.slice(0, MAX_PULL_CHANGES);
      const cursor = changes.length ? changes[changes.length - 1].sequence as string : since;
      await c.query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [device.id]);
      return { serverTime: new Date().toISOString(), cursor, hasMore, changes };
    });
  }

  async events(ctx: RequestCtx, q: PaginationQuery & { status?: string }) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const total = (await c.query(
        `SELECT count(*)::int AS total FROM sync_events
          WHERE outlet_id = $1 AND ($2::text IS NULL OR status = $2)`,
        [outletId, q.status ?? null],
      )).rows[0].total as number;
      const { rows } = await c.query(
        `SELECT id, device_id AS "deviceId", device_seq::text AS "deviceSeq",
                event_id AS "eventId", event_type AS "eventType", occurred_at AS "occurredAt",
                received_at AS "receivedAt", clock_skew_seconds AS "clockSkewSeconds",
                payload, status, resolution_note AS "resolutionNote",
                resolved_by AS "resolvedBy", resolved_at AS "resolvedAt"
           FROM sync_events
          WHERE outlet_id = $1 AND ($2::text IS NULL OR status = $2)
          ORDER BY received_at DESC, id DESC LIMIT $3 OFFSET $4`,
        [outletId, q.status ?? null, q.limit, q.offset],
      );
      return new Page(rows, total, q.page, q.limit);
    });
  }

  async resolve(ctx: RequestCtx, eventId: string, status: 'RESOLVED' | 'REJECTED', note: string) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const result = await c.query(
        `UPDATE sync_events
            SET status = $3, resolution_note = $4, resolved_by = $5, resolved_at = now()
          WHERE id = $1 AND outlet_id = $2 AND status = 'RECEIVED'
          RETURNING id, event_id AS "eventId", status, resolution_note AS "resolutionNote",
                    resolved_at AS "resolvedAt"`,
        [eventId, outletId, status, note, ctx.userId],
      );
      if (!result.rowCount) {
        const exists = await c.query('SELECT id FROM sync_events WHERE id = $1 AND outlet_id = $2', [eventId, outletId]);
        if (!exists.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'SYNC_EVENT_NOT_FOUND', 'Sync event not found');
        throw new AppException(HttpStatus.CONFLICT, 'SYNC_EVENT_ALREADY_RESOLVED', 'Sync event is no longer awaiting resolution');
      }
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'sync.event.resolve', entity: 'sync_event', entityId: eventId,
        meta: { status, note },
      });
      return result.rows[0];
    });
  }
}
