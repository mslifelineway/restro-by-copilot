import { HttpStatus, Injectable } from '@nestjs/common';
import { SessionService } from '../auth/session.service';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors';
import { Page, PaginationQuery } from '../common/pagination';
import { RequestCtx } from '../common/request-context';
import { DbService } from '../db/db.service';

@Injectable()
export class DeviceService {
  constructor(private db: DbService, private audit: AuditService, private sessions: SessionService) {}

  private a(ctx: RequestCtx) { return { tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user' as const }; }

  async register(ctx: RequestCtx, i: { name: string; platform: string; outletId?: string }) {
    return this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      if (i.outletId && !(await c.query('SELECT 1 FROM outlets WHERE id = $1 AND deleted_at IS NULL', [i.outletId])).rowCount) {
        throw new AppException(HttpStatus.BAD_REQUEST, 'OUTLET_NOT_FOUND', 'Unknown outlet');
      }
      const d = (await c.query(
        `INSERT INTO devices (tenant_id, outlet_id, name, platform, registered_by) VALUES ($1,$2,$3,$4,$5)
         RETURNING id, name, platform, outlet_id AS "outletId", status`,
        [ctx.tenantId, i.outletId ?? null, i.name, i.platform, ctx.userId])).rows[0];
      await this.audit.log(c, { ...this.a(ctx), action: 'device.register', entity: 'device', entityId: d.id });
      return d;
    });
  }

  list(ctx: RequestCtx, q: PaginationQuery) {
    return this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      const total = (await c.query('SELECT count(*)::int AS n FROM devices WHERE deleted_at IS NULL')).rows[0].n;
      const rows = (await c.query(
        `SELECT id, name, platform, outlet_id AS "outletId", status, last_seen_at AS "lastSeenAt", created_at AS "createdAt"
           FROM devices WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [q.limit, q.offset])).rows;
      return new Page(rows, total, q.page, q.limit);
    });
  }

  /** Revoking a device ends every session that was opened on it. */
  async revoke(ctx: RequestCtx, id: string) {
    return this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      const r = await c.query(`UPDATE devices SET status = 'revoked' WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id]);
      if (!r.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'DEVICE_NOT_FOUND', 'Device not found');
      const ended = await this.sessions.revoke(c, { deviceId: id }, 'device_revoked');
      await this.audit.log(c, { ...this.a(ctx), action: 'device.revoke', entity: 'device', entityId: id, meta: { sessionsEnded: ended } });
      return { sessionsEnded: ended };
    });
  }
}
