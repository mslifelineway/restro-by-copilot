import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { TtlCache } from '../common/ttl-cache';

export interface TenantState { id: string; status: 'trial' | 'active' | 'suspended' | 'deleted' }

@Injectable()
export class TenantStateService {
  private cache = new TtlCache<TenantState | null>(5_000);
  constructor(private db: DbService) {}

  invalidate(id?: string) { id ? this.cache.delete(id) : this.cache.clear(); }

  async get(id: string): Promise<TenantState | null> {
    const hit = this.cache.get(id);
    if (hit !== undefined) return hit;
    const row = await this.db.tx({ tenantId: id }, async (c) =>
      (await c.query('SELECT id, status FROM tenants WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0] ?? null,
    );
    this.cache.set(id, row);
    return row;
  }
}
