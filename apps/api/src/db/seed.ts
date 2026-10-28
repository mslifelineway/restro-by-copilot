import { Client } from 'pg';
import { FEATURES, PLANS, SYSTEM_ROLES } from '@rms/shared';
import { config } from '../config';
import { hashSecret } from '../common/crypto';

/** Idempotent: upserts plans, feature catalog, plan matrix defaults and the platform super admin. */
export async function runSeed(): Promise<void> {
  const c = new Client({ connectionString: config.databaseOwnerUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const p of PLANS) {
      await c.query(
        `INSERT INTO plans (code, name, price_monthly_paise, limits) VALUES ($1,$2,$3,$4)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, limits = EXCLUDED.limits`,
        [p.code, p.name, p.priceMonthlyPaise, JSON.stringify(p.limits)],
      );
    }
    for (const f of FEATURES) {
      await c.query(
        `INSERT INTO features (key, module, type, description, depends_on) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (key) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description, depends_on = EXCLUDED.depends_on`,
        [f.key, f.module, f.type, f.description, f.dependsOn ?? []],
      );
    }
    // Plan matrix defaults are inserted only for features that have never been mapped, so a
    // super admin's later matrix edits are not overwritten by re-seeding.
    for (const f of FEATURES) {
      const known = await c.query('SELECT 1 FROM plan_features WHERE feature_key = $1 LIMIT 1', [f.key]);
      if (known.rowCount) continue;
      for (const code of f.plans) {
        await c.query(
          `INSERT INTO plan_features (plan_id, feature_key) SELECT id, $2 FROM plans WHERE code = $1 ON CONFLICT DO NOTHING`,
          [code, f.key],
        );
      }
    }
    // Keep system roles of EXISTING tenants in step with the permission catalog (system roles are immutable,
    // so adding newly introduced permissions is always safe).
    for (const [name, def] of Object.entries(SYSTEM_ROLES)) {
      for (const perm of def.permissions) {
        await c.query(
          `INSERT INTO role_permissions (role_id, tenant_id, permission, limits)
           SELECT r.id, r.tenant_id, $2, $3 FROM roles r WHERE r.is_system AND r.name = $1
           ON CONFLICT (role_id, permission) DO NOTHING`,
          [name, perm, JSON.stringify(def.limits?.[perm] ?? {})]);
      }
    }
    await c.query(
      `INSERT INTO platform_users (email, name, role, password_hash) VALUES ($1,'Super Admin','super_admin',$2)
       ON CONFLICT (email) DO NOTHING`,
      [config.platformAdminEmail, await hashSecret(config.platformAdminPassword)],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}

if (require.main === module) {
  runSeed().then(() => console.log('Seed complete')).catch((e) => { console.error(e); process.exit(1); });
}
