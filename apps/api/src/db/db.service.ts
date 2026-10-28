import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { config } from '../config';

/** Which RLS scope a transaction runs in. */
export type DbScope =
  | { tenantId: string; outletId?: string; platform?: false }
  | { platform: true; tenantId?: undefined; outletId?: undefined };

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

  /**
   * Runs fn in a transaction with RLS session settings applied (set_config is_local = true,
   * so settings die with the transaction and never leak across pooled connections).
   */
  async tx<T>(scope: DbScope, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true),
                set_config('app.is_platform', $2, true),
                set_config('app.outlet_id', $3, true)`,
        [
          scope.tenantId ?? '',
          scope.platform ? 'true' : 'false',
          scope.outletId ?? '',
        ],
      );
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  onModuleDestroy() {
    return this.pool.end();
  }
}
