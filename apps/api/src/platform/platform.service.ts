import { AppException } from '../common/errors';
import { BadRequestException, ConflictException, Injectable, NotFoundException, HttpStatus } from '@nestjs/common';
import { SYSTEM_ROLES, TRIAL_DAYS } from '@rms/shared';
import { PoolClient } from 'pg';
import { TenantStateService } from '../auth/tenant-state.service';
import { AuditService } from '../audit/audit.service';
import { hashSecret } from '../common/crypto';
import { Page, PaginationQuery } from '../common/pagination';
import { RequestCtx } from '../common/request-context';
import { DbService } from '../db/db.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { PermissionService } from '../auth/permission.service';

export interface CreateTenantInput {
  name: string; slug: string; planCode?: string;
  timezone?: string; currency?: string; language?: string;
  outletName?: string;
  ownerName: string; ownerEmail: string; ownerPassword: string;
}

@Injectable()
export class PlatformService {
  constructor(
    private db: DbService, private audit: AuditService, private ent: EntitlementService,
    private tenantState: TenantStateService, private perms: PermissionService,
  ) {}

  private actor(ctx: RequestCtx) { return { actorId: ctx.userId, actorKind: 'platform_user' as const }; }

  /** Tenant onboarding: tenant + subscription + first outlet + system roles + owner, atomically. */
  async createTenant(ctx: RequestCtx, i: CreateTenantInput) {
    const ownerHash = await hashSecret(i.ownerPassword);
    return this.db.tx({ platform: true }, async (c) => {
      const plan = (await c.query('SELECT id, code FROM plans WHERE code = $1', [i.planCode ?? 'trial'])).rows[0];
      if (!plan) throw new AppException(HttpStatus.BAD_REQUEST, 'PLAN_NOT_FOUND', `Unknown plan ${i.planCode}`);
      const trial = plan.code === 'trial';
      let tenant;
      try {
        tenant = (await c.query(
          `INSERT INTO tenants (name, slug, status, plan_id, timezone, currency, language)
           VALUES ($1,$2,$3,$4,COALESCE($5,'Asia/Kolkata'),COALESCE($6,'INR'),COALESCE($7,'en')) RETURNING *`,
          [i.name, i.slug, trial ? 'trial' : 'active', plan.id, i.timezone, i.currency, i.language],
        )).rows[0];
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new AppException(HttpStatus.CONFLICT, 'SLUG_TAKEN', `Slug '${i.slug}' is taken`);
        throw e;
      }
      await c.query(
        `INSERT INTO subscriptions (tenant_id, plan_id, status, trial_ends_at, current_period_end)
         VALUES ($1,$2,$3,$4,$4)`,
        [tenant.id, plan.id, trial ? 'trialing' : 'active', trial ? new Date(Date.now() + TRIAL_DAYS * 86_400_000) : null],
      );
      const outlet = (await c.query(
        `INSERT INTO outlets (tenant_id, name, code) VALUES ($1,$2,'MAIN') RETURNING id`, [tenant.id, i.outletName ?? i.name],
      )).rows[0];

      const roleIds = new Map<string, string>();
      for (const [name, def] of Object.entries(SYSTEM_ROLES)) {
        const r = (await c.query(`INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,$2,true) RETURNING id`, [tenant.id, name])).rows[0];
        roleIds.set(name, r.id);
        for (const p of def.permissions) {
          await c.query(
            `INSERT INTO role_permissions (role_id, tenant_id, permission, limits) VALUES ($1,$2,$3,$4)`,
            [r.id, tenant.id, p, JSON.stringify(def.limits?.[p] ?? {})],
          );
        }
      }
      const owner = (await c.query(
        `INSERT INTO users (tenant_id, email, name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
        [tenant.id, i.ownerEmail, i.ownerName, ownerHash],
      )).rows[0];
      await c.query(`INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`, [tenant.id, owner.id, roleIds.get('Owner')]);

      await this.audit.log(c, { ...this.actor(ctx), tenantId: tenant.id, action: 'tenant.create', entity: 'tenant', entityId: tenant.id, meta: { plan: plan.code } });
      return { id: tenant.id, slug: tenant.slug, status: tenant.status, outletId: outlet.id, ownerUserId: owner.id };
    });
  }

  listTenants(q: PaginationQuery) {
    return this.db.tx({ platform: true }, async (c) => {
      const total = (await c.query('SELECT count(*)::int AS n FROM tenants WHERE deleted_at IS NULL')).rows[0].n;
      const rows = (await c.query(
        `SELECT t.id, t.name, t.slug, t.status, p.code AS plan, t.created_at
           FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.deleted_at IS NULL
          ORDER BY t.created_at DESC LIMIT $1 OFFSET $2`, [q.limit, q.offset])).rows;
      return new Page(rows, total, q.page, q.limit);
    });
  }

  async getTenant(id: string) {
    return this.db.tx({ platform: true }, async (c) => {
      const t = (await c.query(
        `SELECT t.*, p.code AS plan FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1 AND t.deleted_at IS NULL`, [id])).rows[0];
      if (!t) throw new AppException(HttpStatus.NOT_FOUND, 'TENANT_NOT_FOUND', 'Tenant not found');
      const sub = (await c.query(`SELECT status, trial_ends_at, current_period_end FROM subscriptions WHERE tenant_id = $1 AND status <> 'canceled'`, [id])).rows[0] ?? null;
      const counts = (await c.query(
        `SELECT (SELECT count(*) FROM outlets WHERE tenant_id=$1 AND deleted_at IS NULL)::int AS outlets,
                (SELECT count(*) FROM users WHERE tenant_id=$1 AND deleted_at IS NULL)::int AS users`, [id])).rows[0];
      return { ...t, subscription: sub, usage: counts };
    });
  }

  async setStatus(ctx: RequestCtx, id: string, status: 'active' | 'suspended' | 'deleted') {
    await this.db.tx({ platform: true }, async (c) => {
      const r = await c.query(
        `UPDATE tenants SET status = $2, deleted_at = CASE WHEN $2 = 'deleted' THEN now() ELSE NULL END
          WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id, status]);
      if (!r.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'TENANT_NOT_FOUND', 'Tenant not found');
      await this.audit.log(c, { ...this.actor(ctx), tenantId: id, action: `tenant.${status}`, entity: 'tenant', entityId: id });
    });
    this.tenantState.invalidate(id);
  }

  async changePlan(ctx: RequestCtx, id: string, planCode: string) {
    await this.db.tx({ platform: true }, async (c) => {
      const plan = (await c.query('SELECT id FROM plans WHERE code = $1', [planCode])).rows[0];
      if (!plan) throw new AppException(HttpStatus.BAD_REQUEST, 'PLAN_NOT_FOUND', `Unknown plan ${planCode}`);
      const r = await c.query(`UPDATE tenants SET plan_id = $2, status = CASE WHEN status = 'trial' AND $3 <> 'trial' THEN 'active' ELSE status END WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id, plan.id, planCode]);
      if (!r.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'TENANT_NOT_FOUND', 'Tenant not found');
      // Proration, invoicing and gateway sync arrive with P2 subscription billing.
      await c.query(
        `UPDATE subscriptions SET plan_id = $2, status = CASE WHEN $3 = 'trial' THEN status ELSE 'active' END WHERE tenant_id = $1 AND status <> 'canceled'`,
        [id, plan.id, planCode]);
      await this.audit.log(c, { ...this.actor(ctx), tenantId: id, action: 'tenant.plan_change', entity: 'tenant', entityId: id, meta: { plan: planCode } });
    });
    this.ent.invalidate(id);
    this.tenantState.invalidate(id);
  }

  // ---------- Feature flags / entitlements (backoffice) ----------
  listPlans() {
    return this.db.tx({ platform: true }, async (c) => (await c.query(
      `SELECT p.code, p.name, p.price_monthly_paise, p.limits,
              COALESCE(array_agg(pf.feature_key ORDER BY pf.feature_key) FILTER (WHERE pf.feature_key IS NOT NULL), '{}') AS features
         FROM plans p LEFT JOIN plan_features pf ON pf.plan_id = p.id GROUP BY p.id ORDER BY p.price_monthly_paise`)).rows);
  }

  listFeatures() {
    return this.db.tx({ platform: true }, async (c) => (await c.query(
      `SELECT key, module, type, description, depends_on, kill_switch FROM features ORDER BY module, key`)).rows);
  }

  private async flagAudit(c: PoolClient, ctx: RequestCtx, e: { tenantId?: string; outletId?: string; key: string; action: string; old?: unknown; next?: unknown; reason?: string }) {
    await c.query(
      `INSERT INTO flag_audit (tenant_id, outlet_id, feature_key, action, old_value, new_value, reason, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [e.tenantId ?? null, e.outletId ?? null, e.key, e.action, JSON.stringify(e.old ?? null), JSON.stringify(e.next ?? null), e.reason ?? null, ctx.userId]);
  }

  async setKillSwitch(ctx: RequestCtx, key: string, on: boolean, reason: string) {
    await this.db.tx({ platform: true }, async (c) => {
      const old = (await c.query('SELECT kill_switch FROM features WHERE key = $1 FOR UPDATE', [key])).rows[0];
      if (!old) throw new AppException(HttpStatus.NOT_FOUND, 'FEATURE_NOT_FOUND', `Unknown feature ${key}`);
      await c.query('UPDATE features SET kill_switch = $2 WHERE key = $1', [key, on]);
      await this.flagAudit(c, ctx, { key, action: 'kill_switch', old: old.kill_switch, next: on, reason });
      await this.audit.log(c, { ...this.actor(ctx), action: 'feature.kill_switch', entity: 'feature', entityId: key, meta: { on, reason } });
    });
    this.ent.invalidate('*');
  }

  async setPlanFeature(ctx: RequestCtx, planCode: string, key: string, enabled: boolean) {
    await this.db.tx({ platform: true }, async (c) => {
      const plan = (await c.query('SELECT id FROM plans WHERE code = $1', [planCode])).rows[0];
      const feat = (await c.query('SELECT 1 FROM features WHERE key = $1', [key])).rowCount;
      if (!plan || !feat) throw new AppException(HttpStatus.NOT_FOUND, 'PLAN_OR_FEATURE_NOT_FOUND', 'Unknown plan or feature');
      if (enabled) await c.query('INSERT INTO plan_features (plan_id, feature_key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [plan.id, key]);
      else await c.query('DELETE FROM plan_features WHERE plan_id = $1 AND feature_key = $2', [plan.id, key]);
      await this.flagAudit(c, ctx, { key, action: 'plan_matrix', next: { plan: planCode, enabled } });
    });
    this.ent.invalidate('*');
  }

  async setTenantFeature(ctx: RequestCtx, tenantId: string, key: string, enabled: boolean, reason: string, expiresAt?: Date, outletId?: string) {
    await this.db.tx({ platform: true }, async (c) => {
      if (!(await c.query('SELECT 1 FROM features WHERE key = $1', [key])).rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'FEATURE_NOT_FOUND', `Unknown feature ${key}`);
      if (!(await c.query('SELECT 1 FROM tenants WHERE id = $1 AND deleted_at IS NULL', [tenantId])).rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'TENANT_NOT_FOUND', 'Tenant not found');
      const old = (outletId
        ? await c.query('SELECT enabled, expires_at FROM outlet_features WHERE tenant_id = $1 AND outlet_id = $2 AND feature_key = $3', [tenantId, outletId, key])
        : await c.query('SELECT enabled, expires_at FROM tenant_features WHERE tenant_id = $1 AND feature_key = $2', [tenantId, key])
      ).rows[0];
      if (outletId) {
        if (!(await c.query('SELECT 1 FROM outlets WHERE id = $1 AND tenant_id = $2', [outletId, tenantId])).rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'OUTLET_NOT_FOUND', 'Outlet not found');
        await c.query(
          `INSERT INTO outlet_features (tenant_id, outlet_id, feature_key, enabled, reason, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (outlet_id, feature_key) DO UPDATE SET enabled = $4, reason = $5, expires_at = $6, created_by = $7`,
          [tenantId, outletId, key, enabled, reason, expiresAt ?? null, ctx.userId]);
      } else {
        await c.query(
          `INSERT INTO tenant_features (tenant_id, feature_key, enabled, reason, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (tenant_id, feature_key) DO UPDATE SET enabled = $3, reason = $4, expires_at = $5, created_by = $6`,
          [tenantId, key, enabled, reason, expiresAt ?? null, ctx.userId]);
      }
      await this.flagAudit(c, ctx, { tenantId, outletId, key, action: 'override_set', old, next: { enabled, expiresAt }, reason });
    });
    this.ent.invalidate(tenantId);
  }

  async clearTenantFeature(ctx: RequestCtx, tenantId: string, key: string, outletId?: string) {
    await this.db.tx({ platform: true }, async (c) => {
      const r = outletId
        ? await c.query('DELETE FROM outlet_features WHERE tenant_id = $1 AND outlet_id = $2 AND feature_key = $3 RETURNING enabled', [tenantId, outletId, key])
        : await c.query('DELETE FROM tenant_features WHERE tenant_id = $1 AND feature_key = $2 RETURNING enabled', [tenantId, key]);
      if (!r.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'OVERRIDE_NOT_FOUND', 'No override to clear');
      await this.flagAudit(c, ctx, { tenantId, outletId, key, action: 'override_clear', old: r.rows[0] });
    });
    this.ent.invalidate(tenantId);
  }

  /** "Effective view": what the tenant (or one of its outlets) actually sees. */
  effective(tenantId: string, outletId?: string) {
    return this.db.tx({ platform: true }, async (c) => [...(await this.ent.resolveWith(c, tenantId, outletId)).values()]);
  }

  flagHistory(q: PaginationQuery, tenantId?: string) {
    return this.db.tx({ platform: true }, async (c) => {
      const total = (await c.query('SELECT count(*)::int AS n FROM flag_audit WHERE ($1::uuid IS NULL OR tenant_id = $1)', [tenantId ?? null])).rows[0].n;
      const rows = (await c.query(
        `SELECT * FROM flag_audit WHERE ($1::uuid IS NULL OR tenant_id = $1) ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [tenantId ?? null, q.limit, q.offset])).rows;
      return new Page(rows, total, q.page, q.limit);
    });
  }
}
