import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbService } from '../db/db.service';
import { TtlCache } from '../common/ttl-cache';

export type EntitlementSource = 'kill_switch' | 'outlet_override' | 'tenant_override' | 'plan' | 'dependency' | 'none';
export interface Entitlement { key: string; module: string; enabled: boolean; source: EntitlementSource }

interface FeatureRow { key: string; module: string; depends_on: string[]; kill_switch: boolean }

@Injectable()
export class EntitlementService {
  private cache = new TtlCache<Map<string, Entitlement>>(5_000);
  constructor(private db: DbService) {}

  invalidate(tenantId: string) {
    this.cache.clear(); // keys are tenant+outlet; clearing all is fine at P0 volumes
    void tenantId;
  }

  /**
   * Resolution order (RMS doc M3A): global kill switch > outlet override > tenant override >
   * plan default. A feature whose dependsOn features are not effective is itself disabled.
   * Expired overrides are ignored.
   */
  async resolveWith(c: PoolClient, tenantId: string, outletId?: string): Promise<Map<string, Entitlement>> {
    const features: FeatureRow[] = (await c.query('SELECT key, module, depends_on, kill_switch FROM features ORDER BY key')).rows;
    const planKeys = new Set<string>(
      (await c.query(
        `SELECT pf.feature_key FROM plan_features pf JOIN tenants t ON t.plan_id = pf.plan_id WHERE t.id = $1`,
        [tenantId],
      )).rows.map((r) => r.feature_key),
    );
    const tenantOv = new Map<string, boolean>(
      (await c.query(`SELECT feature_key, enabled FROM tenant_features WHERE tenant_id = $1 AND (expires_at IS NULL OR expires_at > now())`, [tenantId]))
        .rows.map((r) => [r.feature_key, r.enabled]),
    );
    const outletOv = new Map<string, boolean>(
      outletId
        ? (await c.query(`SELECT feature_key, enabled FROM outlet_features WHERE tenant_id = $1 AND outlet_id = $2 AND (expires_at IS NULL OR expires_at > now())`, [tenantId, outletId]))
            .rows.map((r) => [r.feature_key, r.enabled])
        : [],
    );

    const byKey = new Map(features.map((f) => [f.key, f]));
    const out = new Map<string, Entitlement>();
    const visiting = new Set<string>();

    const resolve = (key: string): Entitlement => {
      const hit = out.get(key);
      if (hit) return hit;
      const f = byKey.get(key)!;
      let e: Entitlement;
      if (f.kill_switch) e = { key, module: f.module, enabled: false, source: 'kill_switch' };
      else if (outletOv.has(key)) e = { key, module: f.module, enabled: outletOv.get(key)!, source: 'outlet_override' };
      else if (tenantOv.has(key)) e = { key, module: f.module, enabled: tenantOv.get(key)!, source: 'tenant_override' };
      else if (planKeys.has(key)) e = { key, module: f.module, enabled: true, source: 'plan' };
      else e = { key, module: f.module, enabled: false, source: 'none' };

      if (e.enabled && f.depends_on.length && !visiting.has(key)) {
        visiting.add(key);
        if (f.depends_on.some((d) => byKey.has(d) && !resolve(d).enabled)) e = { ...e, enabled: false, source: 'dependency' };
        visiting.delete(key);
      }
      out.set(key, e);
      return e;
    };
    features.forEach((f) => resolve(f.key));
    return out;
  }

  async resolve(tenantId: string, outletId?: string): Promise<Map<string, Entitlement>> {
    const k = `${tenantId}:${outletId ?? ''}`;
    const cached = this.cache.get(k);
    if (cached) return cached;
    const v = await this.db.tx({ tenantId }, (c) => this.resolveWith(c, tenantId, outletId));
    this.cache.set(k, v);
    return v;
  }

  async isEnabled(key: string, tenantId: string, outletId?: string): Promise<boolean> {
    return (await this.resolve(tenantId, outletId)).get(key)?.enabled ?? false;
  }
}
