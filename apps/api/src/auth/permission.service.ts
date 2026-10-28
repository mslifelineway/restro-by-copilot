import { Injectable } from '@nestjs/common';
import { Permission, PermissionLimits } from '@rms/shared';
import { DbService } from '../db/db.service';
import { TtlCache } from '../common/ttl-cache';

export type ResolvedPermissions = Map<string, PermissionLimits>;

@Injectable()
export class PermissionService {
  private cache = new TtlCache<ResolvedPermissions>(5_000);
  constructor(private db: DbService) {}

  invalidate() { this.cache.clear(); }

  /**
   * Union of permissions across the user's role assignments. Tenant-wide assignments
   * (outlet_id NULL) always count; outlet-scoped ones only count for that outlet.
   * Where several roles grant the same permission, the most permissive limits win
   * (no limits beats any limit; otherwise the highest numeric value).
   */
  async forUser(tenantId: string, userId: string, outletId?: string): Promise<ResolvedPermissions> {
    const key = `${tenantId}:${userId}:${outletId ?? ''}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const rows = await this.db.tx({ tenantId }, async (c) =>
      (await c.query(
        `SELECT rp.permission, rp.limits FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id AND r.deleted_at IS NULL
           JOIN role_permissions rp ON rp.role_id = r.id
          WHERE ur.user_id = $1 AND (ur.outlet_id IS NULL OR ur.outlet_id = $2::uuid)`,
        [userId, outletId ?? null],
      )).rows,
    );
    const out: ResolvedPermissions = new Map();
    for (const r of rows as { permission: string; limits: PermissionLimits }[]) {
      const prev = out.get(r.permission);
      out.set(r.permission, prev ? mergeLimits(prev, r.limits) : r.limits);
    }
    this.cache.set(key, out);
    return out;
  }

  async has(tenantId: string, userId: string, p: Permission, outletId?: string) {
    return (await this.forUser(tenantId, userId, outletId)).get(p);
  }
}

function mergeLimits(a: PermissionLimits, b: PermissionLimits): PermissionLimits {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (!ka.length || !kb.length) return {};
  const out: PermissionLimits = {};
  for (const k of ka) {
    if (!(k in b)) continue; // limit absent on one side = unlimited on that dimension
    out[k] = typeof a[k] === 'number' && typeof b[k] === 'number' ? Math.max(a[k] as number, b[k] as number) : a[k];
  }
  return out;
}
