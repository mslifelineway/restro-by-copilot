/**
 * SPIKE (P0): can Drizzle ORM be used on top of our per-transaction RLS scoping without weakening it?
 * Approach under test: DbService.tx() opens the transaction and sets app.tenant_id; we hand the SAME pg
 * client to drizzle(client). Drizzle then issues its queries on that transaction, so RLS applies.
 * See docs/adr/0002-orm-drizzle.md for the decision.
 */
import 'reflect-metadata';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { DbService } from '../src/db/db.service';
import { runMigrations } from '../src/db/migrate';
import { Client } from 'pg';
import { config } from '../src/config';

const outlets = pgTable('outlets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  code: text('code').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

describe('spike: Drizzle on the RLS-scoped transaction client', () => {
  const db = new DbService();
  const tenants: string[] = [];

  beforeAll(async () => {
    await runMigrations();
    // create two tenants with the owner connection (bypasses RLS) — fixtures only
    const owner = new Client({ connectionString: config.databaseOwnerUrl });
    await owner.connect();
    const plan = (await owner.query(`INSERT INTO plans (code, name) VALUES ('spike', 'Spike') ON CONFLICT (code) DO UPDATE SET name = 'Spike' RETURNING id`)).rows[0].id;
    for (const k of ['a', 'b']) {
      const slug = `spike-${k}-${randomUUID().slice(0, 8)}`;
      const t = (await owner.query(`INSERT INTO tenants (name, slug, plan_id) VALUES ($1,$2,$3) RETURNING id`, [slug, slug, plan])).rows[0].id;
      await owner.query(`INSERT INTO outlets (tenant_id, name, code) VALUES ($1,'Main','MAIN')`, [t]);
      tenants.push(t);
    }
    await owner.end();
  });
  afterAll(() => db.onModuleDestroy());

  it('typed queries through drizzle only see the scoped tenant\'s rows', async () => {
    const rows = await db.tx({ tenantId: tenants[0] }, (c) => drizzle(c).select().from(outlets).where(isNull(outlets.deletedAt)));
    expect(rows.map((r) => r.tenantId)).toEqual([tenants[0]]);
  });

  it('forgetting a tenant filter cannot leak: no WHERE at all still returns one tenant', async () => {
    const all = await db.tx({ tenantId: tenants[1] }, (c) => drizzle(c).select().from(outlets));
    expect(new Set(all.map((r) => r.tenantId))).toEqual(new Set([tenants[1]]));
  });

  it('cross-tenant writes are blocked by RLS (insert errors, update touches nothing)', async () => {
    // FINDING: Drizzle wraps driver errors ("Failed query: ..."); the original pg error is on `.cause`.
    // Our unique-violation handling (`e.code === '23505'`) must unwrap `cause` when services move to Drizzle.
    const err = await db.tx({ tenantId: tenants[0] }, (c) => drizzle(c).insert(outlets).values({ tenantId: tenants[1], name: 'x', code: 'X' })).catch((e) => e);
    expect(err.message).toMatch(/Failed query/);
    expect((err.cause as Error).message).toMatch(/row-level security/);
    const updated = await db.tx({ tenantId: tenants[0] }, (c) =>
      drizzle(c).update(outlets).set({ name: 'hacked' }).where(eq(outlets.tenantId, tenants[1])).returning());
    expect(updated).toHaveLength(0);
  });

  it('writes within scope work and roll back with the transaction', async () => {
    await expect(db.tx({ tenantId: tenants[0] }, async (c) => {
      await drizzle(c).insert(outlets).values({ tenantId: tenants[0], name: 'Temp', code: 'TEMP' });
      throw new Error('boom');
    })).rejects.toThrow('boom');
    const rows = await db.tx({ tenantId: tenants[0] }, (c) => drizzle(c).select().from(outlets).where(and(eq(outlets.code, 'TEMP'))));
    expect(rows).toHaveLength(0);
  });

  it('raw SQL escape hatch (sql``) is available on the same client for RLS-aware reporting queries', async () => {
    const r = await db.tx({ tenantId: tenants[0] }, (c) => drizzle(c).execute(sql`SELECT count(*)::int AS n FROM outlets`));
    expect(r.rows[0]).toEqual({ n: 1 });
  });

  it('pooled connections do not retain tenant scope between transactions', async () => {
    await db.tx({ tenantId: tenants[0] }, (c) => drizzle(c).select().from(outlets));
    const leaked = await db.pool.query('SELECT * FROM outlets'); // no tx, no set_config
    expect(leaked.rowCount).toBe(0);
  });
});
