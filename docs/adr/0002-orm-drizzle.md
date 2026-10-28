# ADR-0002: Drizzle ORM for domain queries (query builder only)

Status: accepted (result of the P0 ORM + RLS spike, `apps/api/test/spike-drizzle-rls.e2e-spec.ts`)

## Context
The product doc asks for an ORM/query-layer spike (Drizzle or TypeORM) because Prisma has friction with
Postgres RLS and per-request tenant context. Our isolation model sets `app.tenant_id` with `set_config(..., true)`
inside a transaction opened by `DbService.tx()`.

## Findings
Drizzle works on top of that model without weakening it, by passing the transaction's own `pg` client:
`db.tx({ tenantId }, (c) => drizzle(c).select()...)`. The spike proves:
- typed queries only see the scoped tenant's rows, even with no `WHERE tenant_id`;
- cross-tenant INSERTs are rejected by RLS and UPDATEs touch zero rows;
- work rolls back with the surrounding transaction;
- the `sql` template is available for raw/reporting queries on the same client;
- a pooled connection carries no tenant scope after the transaction ends.

Gotchas to handle when adopting:
1. **Drizzle wraps driver errors** (`DrizzleQueryError: Failed query ...`); the original pg error (with `.code`, e.g. `23505`) is on `.cause`.
   Any unique-violation handling must unwrap `cause`.
2. Create ONE `drizzle(c)` per transaction client; never keep a module-level `drizzle(pool)` (it would run outside the RLS scope).
3. `drizzle-kit` migrations are **not** used: schema changes stay hand-written SQL (RLS policies, triggers, grants don't fit generated migrations).
   Table definitions in TypeScript (`pgTable`) must mirror the SQL migrations.

## Decision
- Adopt **Drizzle (query builder + `pgTable` definitions)** for new domain modules from P1 (menu, orders, billing, inventory).
- Keep SQL-only migrations and the `DbService.tx()` scoping as the single entry point to the database.
- Do **not** rewrite the P0 modules; the raw-SQL services are covered by tests and stay as they are.
- TypeORM and Prisma are not adopted.

## Consequences
- Add `apps/api/src/db/schema/` (per-module `pgTable`s) with the first P1 module, plus a helper that unwraps `DrizzleQueryError.cause`.
- The tenant-isolation tests must also cover each new Drizzle-based repository.
