import { AppException } from '../common/errors';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, HttpStatus } from '@nestjs/common';
import { PERMISSIONS, PermissionLimits } from '@rms/shared';
import { PermissionService } from '../auth/permission.service';
import { SessionService } from '../auth/session.service';
import { AuditService } from '../audit/audit.service';
import { hashSecret } from '../common/crypto';
import { Page, PaginationQuery } from '../common/pagination';
import { RequestCtx } from '../common/request-context';
import { DbService } from '../db/db.service';

const isUnique = (e: unknown) => (e as { code?: string }).code === '23505';

@Injectable()
export class TenantService {
  constructor(private db: DbService, private audit: AuditService, private perms: PermissionService, private sessions: SessionService) {}

  private a(ctx: RequestCtx) { return { tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user' as const }; }

  // ---------- Tenant profile ----------
  getTenant(ctx: RequestCtx) {
    return this.db.tx({ tenantId: ctx.tenantId! }, async (c) => (await c.query(
      `SELECT t.id, t.name, t.slug, t.status, p.code AS plan, t.timezone, t.currency, t.language, t.date_format
         FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`, [ctx.tenantId])).rows[0]);
  }

  async updateTenant(ctx: RequestCtx, patch: { name?: string; timezone?: string; currency?: string; language?: string; dateFormat?: string }) {
    await this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      await c.query(
        `UPDATE tenants SET name = COALESCE($2,name), timezone = COALESCE($3,timezone), currency = COALESCE($4,currency),
                language = COALESCE($5,language), date_format = COALESCE($6,date_format) WHERE id = $1`,
        [ctx.tenantId, patch.name, patch.timezone, patch.currency, patch.language, patch.dateFormat]);
      await this.audit.log(c, { ...this.a(ctx), action: 'tenant.update', entity: 'tenant', entityId: ctx.tenantId, meta: patch });
    });
  }

  // ---------- Outlets ----------
  listOutlets(ctx: RequestCtx, q: PaginationQuery) {
    return this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      const total = (await c.query('SELECT count(*)::int AS n FROM outlets WHERE deleted_at IS NULL')).rows[0].n;
      const rows = (await c.query(
        `SELECT id, name, code, address, gstin, timezone FROM outlets WHERE deleted_at IS NULL ORDER BY created_at LIMIT $1 OFFSET $2`, [q.limit, q.offset])).rows;
      return new Page(rows, total, q.page, q.limit);
    });
  }

  async createOutlet(ctx: RequestCtx, i: { name: string; code: string; gstin?: string; timezone?: string; address?: object }) {
    return this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      const lim = (await c.query(
        `SELECT (p.limits->>'outlets')::int AS max, (SELECT count(*) FROM outlets WHERE deleted_at IS NULL)::int AS used
           FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`, [ctx.tenantId])).rows[0];
      if (lim.used >= lim.max) throw new AppException(HttpStatus.FORBIDDEN, 'PLAN_LIMIT_REACHED', 'Plan outlet limit reached', { limit: 'outlets' });
      try {
        const o = (await c.query(
          `INSERT INTO outlets (tenant_id, name, code, gstin, timezone, address) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, code`,
          [ctx.tenantId, i.name, i.code, i.gstin ?? null, i.timezone ?? null, JSON.stringify(i.address ?? {})])).rows[0];
        await this.audit.log(c, { ...this.a(ctx), action: 'outlet.create', entity: 'outlet', entityId: o.id });
        return o;
      } catch (e) {
        if (isUnique(e)) throw new AppException(HttpStatus.CONFLICT, 'OUTLET_CODE_TAKEN', `Outlet code '${i.code}' already exists`);
        throw e;
      }
    });
  }

  async updateOutlet(ctx: RequestCtx, id: string, p: { name?: string; gstin?: string; timezone?: string; address?: object }) {
    await this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      const r = await c.query(
        `UPDATE outlets SET name = COALESCE($2,name), gstin = COALESCE($3,gstin), timezone = COALESCE($4,timezone), address = COALESCE($5,address)
          WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
        [id, p.name, p.gstin, p.timezone, p.address ? JSON.stringify(p.address) : null]);
      if (!r.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'OUTLET_NOT_FOUND', 'Outlet not found');
      await this.audit.log(c, { ...this.a(ctx), action: 'outlet.update', entity: 'outlet', entityId: id });
    });
  }

  async deleteOutlet(ctx: RequestCtx, id: string) {
    await this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      const left = (await c.query('SELECT count(*)::int AS n FROM outlets WHERE deleted_at IS NULL AND id <> $1', [id])).rows[0].n;
      if (!left) throw new AppException(HttpStatus.CONFLICT, 'LAST_OUTLET', 'A tenant must keep at least one outlet');
      const r = await c.query('UPDATE outlets SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id', [id]);
      if (!r.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'OUTLET_NOT_FOUND', 'Outlet not found');
      await this.audit.log(c, { ...this.a(ctx), action: 'outlet.delete', entity: 'outlet', entityId: id });
    });
  }

  // ---------- Users ----------
  listUsers(ctx: RequestCtx, q: PaginationQuery) {
    return this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      const total = (await c.query('SELECT count(*)::int AS n FROM users WHERE deleted_at IS NULL')).rows[0].n;
      const rows = (await c.query(
      `SELECT u.id, u.email, u.name, u.status,
              COALESCE(json_agg(json_build_object('roleId', r.id, 'role', r.name, 'outletId', ur.outlet_id)) FILTER (WHERE r.id IS NOT NULL), '[]') AS roles
         FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id
        WHERE u.deleted_at IS NULL GROUP BY u.id ORDER BY u.created_at LIMIT $1 OFFSET $2`, [q.limit, q.offset])).rows;
      return new Page(rows, total, q.page, q.limit);
    });
  }

  async createUser(ctx: RequestCtx, i: { email: string; name: string; password?: string; pin?: string; assignments: { roleId: string; outletId?: string }[] }) {
    const [password_hash, pin_hash] = await Promise.all([i.password ? hashSecret(i.password) : null, i.pin ? hashSecret(i.pin) : null]);
    const out = await this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      const lim = (await c.query(
        `SELECT (p.limits->>'users')::int AS max, (SELECT count(*) FROM users WHERE deleted_at IS NULL)::int AS used
           FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`, [ctx.tenantId])).rows[0];
      if (lim.used >= lim.max) throw new AppException(HttpStatus.FORBIDDEN, 'PLAN_LIMIT_REACHED', 'Plan user limit reached', { limit: 'users' });
      let u;
      try {
        u = (await c.query(
          `INSERT INTO users (tenant_id, email, name, password_hash, pin_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id, email, name`,
          [ctx.tenantId, i.email, i.name, password_hash, pin_hash])).rows[0];
      } catch (e) {
        if (isUnique(e)) throw new AppException(HttpStatus.CONFLICT, 'EMAIL_IN_USE', 'Email already in use');
        throw e;
      }
      for (const a of i.assignments) await this.assign(c, ctx.tenantId!, u.id, a.roleId, a.outletId);
      await this.audit.log(c, { ...this.a(ctx), action: 'user.create', entity: 'user', entityId: u.id });
      return u;
    });
    return out;
  }

  /** RLS already confines roles/outlets to this tenant; the existence checks give clean 400s. */
  private async assign(c: import('pg').PoolClient, tenantId: string, userId: string, roleId: string, outletId?: string) {
    if (!(await c.query('SELECT 1 FROM roles WHERE id = $1 AND deleted_at IS NULL', [roleId])).rowCount) throw new AppException(HttpStatus.BAD_REQUEST, 'ROLE_NOT_FOUND', 'Unknown role');
    if (outletId && !(await c.query('SELECT 1 FROM outlets WHERE id = $1 AND deleted_at IS NULL', [outletId])).rowCount) throw new AppException(HttpStatus.BAD_REQUEST, 'OUTLET_NOT_FOUND', 'Unknown outlet');
    await c.query(`INSERT INTO user_roles (tenant_id, user_id, role_id, outlet_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [tenantId, userId, roleId, outletId ?? null]);
  }

  /** Disabling a user ends all of their sessions immediately. */
  async updateUser(ctx: RequestCtx, id: string, p: { name?: string; status?: 'active' | 'disabled' }) {
    if (p.status === 'disabled' && id === ctx.userId) throw new AppException(HttpStatus.BAD_REQUEST, 'CANNOT_DISABLE_SELF', 'You cannot disable your own account');
    await this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      const r = await c.query(`UPDATE users SET name = COALESCE($2,name), status = COALESCE($3,status) WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id, p.name, p.status]);
      if (!r.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'USER_NOT_FOUND', 'User not found');
      if (p.status === 'disabled') await this.sessions.revoke(c, { kind: 'tenant', userId: id }, 'user_disabled');
      await this.audit.log(c, { ...this.a(ctx), action: 'user.update', entity: 'user', entityId: id, meta: p });
    });
  }

  async forceLogout(ctx: RequestCtx, userId: string) {
    return this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      if (!(await c.query('SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL', [userId])).rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'USER_NOT_FOUND', 'User not found');
      const ended = await this.sessions.revoke(c, { kind: 'tenant', userId }, 'force_logout');
      await this.audit.log(c, { ...this.a(ctx), action: 'user.force_logout', entity: 'user', entityId: userId, meta: { sessionsEnded: ended } });
      return { sessionsEnded: ended };
    });
  }

  // ---------- Own sessions ----------
  listOwnSessions(ctx: RequestCtx) {
    return this.db.tx({ tenantId: ctx.tenantId! }, async (c) => (await c.query(
      `SELECT id, device_id AS "deviceId", user_agent AS "userAgent", ip, created_at AS "createdAt", expires_at AS "expiresAt", (id = $2 OR family_id = (SELECT family_id FROM sessions WHERE id = $2)) AS current
         FROM sessions WHERE kind = 'tenant' AND user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
      [ctx.userId, ctx.sessionId])).rows);
  }

  async revokeOwnSession(ctx: RequestCtx, sessionId: string) {
    await this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      const own = (await c.query(`SELECT 1 FROM sessions WHERE id = $1 AND kind = 'tenant' AND user_id = $2`, [sessionId, ctx.userId])).rowCount;
      if (!own) throw new AppException(HttpStatus.NOT_FOUND, 'SESSION_NOT_FOUND', 'Session not found');
      await this.sessions.revoke(c, { sessionId }, 'user_revoked');
    });
  }

  async setPin(ctx: RequestCtx, userId: string, pin: string) {
    const h = await hashSecret(pin);
    await this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      const r = await c.query('UPDATE users SET pin_hash = $2, failed_attempts = 0, locked_until = NULL WHERE id = $1 AND deleted_at IS NULL', [userId, h]);
      if (!r.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'USER_NOT_FOUND', 'User not found');
      await this.audit.log(c, { ...this.a(ctx), action: 'user.set_pin', entity: 'user', entityId: userId });
    });
  }

  async setUserRoles(ctx: RequestCtx, userId: string, assignments: { roleId: string; outletId?: string }[]) {
    await this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      if (!(await c.query('SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL', [userId])).rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'USER_NOT_FOUND', 'User not found');
      await c.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
      for (const a of assignments) await this.assign(c, ctx.tenantId!, userId, a.roleId, a.outletId);
      await this.audit.log(c, { ...this.a(ctx), action: 'user.set_roles', entity: 'user', entityId: userId, meta: { assignments } });
    });
    this.perms.invalidate();
  }

  // ---------- Roles ----------
  listRoles(ctx: RequestCtx) {
    return this.db.tx({ tenantId: ctx.tenantId! }, async (c) => (await c.query(
      `SELECT r.id, r.name, r.is_system,
              COALESCE(json_agg(json_build_object('permission', rp.permission, 'limits', rp.limits) ORDER BY rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '[]') AS permissions
         FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id WHERE r.deleted_at IS NULL GROUP BY r.id ORDER BY r.is_system DESC, r.name`)).rows);
  }

  private validate(perms: { permission: string; limits?: PermissionLimits }[]) {
    const bad = perms.filter((p) => !(PERMISSIONS as readonly string[]).includes(p.permission));
    if (bad.length) throw new AppException(HttpStatus.BAD_REQUEST, 'UNKNOWN_PERMISSION', `Unknown permissions: ${bad.map((b) => b.permission).join(', ')}`);
  }

  async createRole(ctx: RequestCtx, name: string, perms: { permission: string; limits?: PermissionLimits }[]) {
    this.validate(perms);
    return this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      let r;
      try { r = (await c.query(`INSERT INTO roles (tenant_id, name) VALUES ($1,$2) RETURNING id, name`, [ctx.tenantId, name])).rows[0]; }
      catch (e) { if (isUnique(e)) throw new AppException(HttpStatus.CONFLICT, 'ROLE_NAME_TAKEN', 'Role name already exists'); throw e; }
      for (const p of perms) {
        await c.query(`INSERT INTO role_permissions (role_id, tenant_id, permission, limits) VALUES ($1,$2,$3,$4) ON CONFLICT (role_id, permission) DO UPDATE SET limits = EXCLUDED.limits`,
          [r.id, ctx.tenantId, p.permission, JSON.stringify(p.limits ?? {})]);
      }
      await this.audit.log(c, { ...this.a(ctx), action: 'role.create', entity: 'role', entityId: r.id });
      return r;
    });
  }

  async setRolePermissions(ctx: RequestCtx, roleId: string, perms: { permission: string; limits?: PermissionLimits }[]) {
    this.validate(perms);
    await this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      const r = (await c.query('SELECT is_system FROM roles WHERE id = $1 AND deleted_at IS NULL', [roleId])).rows[0];
      if (!r) throw new AppException(HttpStatus.NOT_FOUND, 'ROLE_NOT_FOUND', 'Role not found');
      if (r.is_system) throw new AppException(HttpStatus.FORBIDDEN, 'SYSTEM_ROLE_IMMUTABLE', 'System roles cannot be edited; create a custom role instead');
      await c.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
      for (const p of perms) {
        await c.query(`INSERT INTO role_permissions (role_id, tenant_id, permission, limits) VALUES ($1,$2,$3,$4)`, [roleId, ctx.tenantId, p.permission, JSON.stringify(p.limits ?? {})]);
      }
      await c.query('UPDATE tenants SET perm_version = perm_version + 1 WHERE id = $1', [ctx.tenantId]);
      await this.audit.log(c, { ...this.a(ctx), action: 'role.set_permissions', entity: 'role', entityId: roleId, meta: { count: perms.length } });
    });
    this.perms.invalidate();
  }

  // ---------- Subscription / audit ----------
  getSubscription(ctx: RequestCtx) {
    return this.db.tx({ tenantId: ctx.tenantId! }, async (c) => (await c.query(
      `SELECT s.status, s.billing_interval, s.trial_ends_at, s.current_period_end, p.code AS plan, p.name AS plan_name, p.limits,
              (SELECT count(*) FROM outlets WHERE deleted_at IS NULL)::int AS outlets_used,
              (SELECT count(*) FROM users WHERE deleted_at IS NULL)::int AS users_used
         FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.status <> 'canceled'`)).rows[0] ?? null);
  }

  listAudit(ctx: RequestCtx, q: PaginationQuery) {
    return this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      const total = (await c.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n;
      const rows = (await c.query(
        `SELECT id, actor_id, actor_kind, action, entity, entity_id, meta, created_at FROM audit_log ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [q.limit, q.offset])).rows;
      return new Page(rows, total, q.page, q.limit);
    });
  }
}
