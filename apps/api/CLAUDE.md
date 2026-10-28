# apps/api — NestJS backend

## Commands (from repo root unless noted)
```bash
pnpm dev                       # nest start --watch, port 3100
pnpm --filter @rms/api build   # nest build -> dist/
pnpm --filter @rms/api typecheck
pnpm --filter @rms/api test    # jest e2e, runs migrations+seed itself, needs `pnpm db:up`
pnpm db:migrate                # apply SQL migrations as OWNER role
pnpm db:seed                   # idempotent: plans, feature catalog, plan matrix, platform admin
```
Do not enable `incremental` in `tsconfig.json`: with Nest's clean outDir it leaves a stale tsbuildinfo and emits an incomplete `dist/`.

## Structure
```
src/
  main.ts, app.setup.ts     bootstrap; app.setup.ts wires prefix, request-id, pipe, interceptor, filter (tests use it too)
  app.module.ts, config.ts  root module; ALL env access goes through config.ts
  common/                   cross-cutting: decorators, errors, pagination, response + idempotency interceptors,
                            exception filter, validation, request-id, crypto, ttl-cache, request-context
  security/                 rate limiting (throttler) + idempotency provider
  db/                       DbService (transactions + RLS scope), migrate.ts, seed.ts, migrations/*.sql
  auth/                     login/refresh/logout, change/forgot/reset password, guards (global chain), session, permission & tenant-state services
  platform/                 super-admin/support API  (/api/v1/platform/*)
  tenant/                   tenant-user API: profile, outlets, users, roles, devices, sessions, subscription, audit, entitlements;
                            P1 M4: menu/tax catalog/CSV; M5: billing; M6: floor tables; M7: orders/KOT/hold-resume/printer dispatch; M10: inventory/purchasing; M16: cashier shifts/daily sales reports; offline sync inbox/change feed
  entitlements/             feature-flag resolution (kill switch > outlet > tenant > plan, + dependencies)
  audit/                    AuditService
  mail/                     MailService (console transport for dev/test, SMTP for prod) + dev-only outbox endpoint
  health/                   GET /health (no /api prefix, unauthenticated)
test/*.e2e-spec.ts          full-stack tests against real Postgres
```
New domain = new folder with `*.module.ts`, `*.controller.ts`, `*.service.ts`, DTOs next to the controller.

## Architecture rules
- Modular monolith. Modules talk through exported services, never by reaching into another module's tables ad hoc
  (shared infra — Db, Audit, Entitlement, Auth — is `@Global`).
- **Controller = HTTP only** (DTO in, call service, return data). **Service = business logic + SQL.** No SQL in controllers.
- **Routes:** global prefix `/api`, controllers declare `v1/...` → `/api/v1/...`. Version bumps are new controllers, not edits.
- **Guard chain (global, order matters):** `AuthGuard` → `AudienceGuard` → `FeatureGuard` → `PermissionGuard`.
  - Routes are private by default; opt out with `@Public()`.
  - Tenant routes: `@TenantOnly()` + `@RequirePermission('resource:action')` (permissions come from the catalog in `@rms/shared`).
  - Platform routes: `@PlatformOnly()`; mutations `@PlatformOnly('super_admin')` (support agents are read-only).
  - Module gating: `@RequireFeature('kds')`. Never gate core features.
- New permission or feature flag → add to `packages/shared` (catalog), rebuild shared, re-run `db:seed`.
- **Idempotency:** `IdempotencyInterceptor` handles the `Idempotency-Key` header for every authenticated write — don't re-implement it per endpoint. Handlers must return JSON-serialisable data, and failures must throw (a thrown error releases the key so the client can retry). It is registered *inside* `ResponseInterceptor` (see `app.setup.ts`); keep that order.
- **Sessions:** never mint JWTs outside `AuthService`. Revoking access (logout, disable user, revoke device, force logout) goes through `SessionService.revoke`, which ends the whole rotation chain and takes effect within ~5 s via the `isActive` cache.

## Response contract (fixed — do not deviate)
Implemented by `ResponseInterceptor`, `AllExceptionsFilter`, `validationPipe`; types in `@rms/shared` (`ApiSuccess`, `ApiErrorBody`).
- Success: `{ success: true, statusCode, message, data, timestamp, path, requestId }`
- Paginated: same plus `meta.pagination { page, limit, totalItems, totalPages, hasNextPage, hasPreviousPage }`
- Error: `{ success: false, statusCode, error: { code, message, details? }, timestamp, path, requestId }`
- Validation: `error.code = 'VALIDATION_FAILED'`, `error.details = [{ field, rule, message }]` (nested fields as `address.zipCode`)
- Handlers **return plain data** (or `new Page(items, total, page, limit)` for lists). Never build the envelope yourself, never
  use `@Res()`, never return `{ success: ... }` from a handler.
- Set the message with `@ResponseMessage('User fetched successfully')` on every handler (default is generic).
- Mutations with nothing to return respond **200 with `data: null`** — don't use 204 (an envelope can't be sent with it).
- `path` is `req.originalUrl`; `requestId` is the inbound `x-request-id` if a UUID, else generated; echoed in the response header.

## DTOs & validation
- One class per request shape, with `class-validator` decorators; global pipe is `whitelist + forbidNonWhitelisted + transform`,
  so unknown fields are rejected (400) — add fields to the DTO, don't loosen the pipe.
- List endpoints take `PaginationQuery` (`page` ≥1, `limit` 1–100, default 20). Extend it for filters
  (see `FlagHistoryQuery`). Return `Page`.
- Params use `ParseUUIDPipe`. Validate enums with `@IsIn`/`@IsEnum`. Emails, slugs, PINs have explicit rules — copy existing DTOs.
- DTOs never expose DB columns directly: SELECT the columns you return, never `SELECT *` on tables with secrets
  (`users`, `platform_users` have password/PIN hashes).

## Database
- ORM decision: see `docs/adr/0002-orm-drizzle.md` — new P1 domain modules use Drizzle on the `DbService.tx()` client (`drizzle(c)` per transaction; unwrap `error.cause` for pg error codes). P0 modules stay raw SQL.
- Postgres 16, **SQL migrations only** in `src/db/migrations/NNNN_name.sql`, forward-only, additive (expand/contract). Never edit an applied migration.
- Every tenant table: `tenant_id uuid NOT NULL`, `created_at`, `updated_at`, `deleted_at` (soft delete), `version` (bumped by trigger),
  UUID PK, **RLS enabled + FORCED** with the `tenant_isolation` policy. A migration adding a tenant table without RLS is a bug.
- The app connects as `rms_app` (no BYPASSRLS). Migrations/seed use the owner URL. Append-only tables (`audit_log`, `flag_audit`, later
  `stock_ledger`) have UPDATE/DELETE revoked from `rms_app`.
- **Always query through `DbService.tx(scope, fn)`** — it sets `app.tenant_id`/`app.is_platform`/`app.outlet_id` with `set_config(..., true)`.
  Tenant code uses `{ tenantId }`; outlet-scoped code also passes `outletId`. `{ platform: true }` is only used in `@PlatformOnly` paths and the login flow.
- Menu catalog APIs require an active outlet context. Category, item, variant, and price access is constrained to that outlet by RLS; tax slabs and reusable add-on groups are tenant-scoped. Monetary prices are non-negative paise stored as PostgreSQL `bigint` and accepted/returned as decimal strings to avoid JS floating-point precision loss.
- Menu CSV import/export uses `/api/v1/menu/import` and `/api/v1/menu/export`; the CSV contains item and variant data, references categories by outlet name and tax slabs by code, and stores prices as integer paise strings. Import is atomic, bounded to 1000 rows, merges by same-outlet `itemId` or SKU, and never deletes omitted records.
- Floor table APIs require `x-outlet-id`; table definitions are managed with `table:manage`, while state changes require `order:create`. Occupied tables cannot be soft-deleted; state transitions are validated and audited.
- Order APIs require `x-outlet-id`; dine-in orders lock and occupy an available/reserved table, and items snapshot current channel price and tax rates. KOT ticket creation is transactional and only sends pending items once; kitchen state transitions use `kot:manage`. Configured printer stations route menu categories; KOT creation durably queues jobs in the same transaction. Clients poll leased jobs, print locally, and acknowledge `PRINTED` or `FAILED`; a queued or acknowledged job does not prove a physical print unless the client reports it.
- Billing prices and configured service charges are tax-inclusive; GST is extracted with integer paise rounding at invoice finalization. Percentage or fixed discounts reduce the pre-GST consideration proportionally by line; `discount:apply` limits apply to both modes. Tips are separate non-taxable invoice amounts, and the final amount payable rounds to the nearest rupee with a signed round-off line. Outlet-level service-charge settings may use a fixed paise amount or percentage and an explicitly selected tax slab. Invoice numbering uses a transactionally updated counter per outlet/financial year/series. Invoice, payment, refund, and void records are append-only for `rms_app`; payment totals cannot exceed the invoice balance, refunds cannot exceed a payment's unrefunded amount, and an invoice can only be voided after its payments are fully refunded. Strict gapless numbering means devices cannot finalize numbered invoices offline.
- Unbilled ready orders can be merged for billing only within one outlet and one order type. Split billing assigns every remaining order-item quantity exactly once across at least two invoices; previous invoice-line quantities are locked against reallocation, and merged group orders complete together.
- Active dine-in orders may be transferred to an available/reserved table within the selected outlet. Table status and order assignment are updated transactionally, and floor-table reads include the active order start time for elapsed-time display.
- Dine-in orders may join/unjoin additional tables. Joined tables stay occupied for the life of the order, cannot be manually released, and are released with their order. Waiters are active users with a tenant-wide or selected-outlet role assignment; waiter assignment is per order and audited.
- Inventory balances are derived from append-only `stock_ledger` rows; stock quantities are integer milli-units. Manual outgoing movements lock inventory items and reject negative balances. KOT-time recipe consumption is atomic with ticket creation, idempotent per KOT line/ingredient, skips menu items without recipes, and may result in negative balances. Purchase orders allow partial receipts; receiving records, purchase line counters, and stock ledger movements commit together.
- Cash payments require an open cashier shift and are linked to it; cash refunds and append-only drawer adjustments are also attributed to open shifts. Shift close snapshots expected/count/variance paise totals from opening cash, payments, refunds, and adjustments. Shift close, payment, refund, and adjustment writes serialize on the shift row.
- Parameterised queries only (`$1`); never interpolate user input into SQL. Table/column names interpolated must come from a fixed whitelist.
- Money = integer paise. Timestamps `timestamptz` (UTC). Ledger-style data is append-only; stock is never updated in place.
- Do multi-step writes in one transaction, and write the audit row in that same transaction.

## Errors & logging
- Throw `AppException(HttpStatus.X, 'DOMAIN_CODE', 'Human message', details?)` for every expected failure. Codes are stable
  SCREAMING_SNAKE (`USER_NOT_FOUND`, `SLUG_TAKEN`, `PLAN_LIMIT_REACHED`, `FEATURE_DISABLED`, `PERMISSION_DENIED`) and are part of the API.
  Don't throw bare `NotFoundException('...')` — the client would only get a generic code.
- Auth failures stay generic (`INVALID_CREDENTIALS`) — never reveal whether a tenant/email exists.
- Unknown errors become `500 INTERNAL_ERROR` with no internals in the body; the full stack is logged with the `requestId`.
- Use Nest `Logger`, not `console.log`. Never log secrets, tokens, PINs, password hashes or raw request bodies.

## Config & security
- Env is read **only** in `config.ts`. In production missing required vars throw at boot. Add new vars to `.env.example`.
- Passwords/PINs: scrypt (`common/crypto.ts`), lockout after 5 failures / 15 min. JWT HS256, 15 min access token (`sid` claim = session id), 7-day rotating refresh token (hash only in DB; reuse outside a 10 s leeway revokes the chain); verification is isolated in `AuthGuard`
  (Auth0 + BFF is the planned swap — keep token logic out of services).
- **Rate limiting:** global per-IP bucket plus a stricter `@Throttle(authLimit)` on every unauthenticated auth route (new public credential-taking routes must add it). Behind a proxy set `TRUST_PROXY`, otherwise all users share one bucket.
- helmet is on globally; don't disable it per route.
- **Passwords:** policy lives in `@rms/shared` (`PASSWORD_MIN_LENGTH`/`MAX`); use those constants in DTOs. Wrong *current* password on an authenticated route must be **400**, never 401 (clients treat 401 as an expired session and sign the user out). Anything that changes a credential must end the user's other sessions via `SessionService.revoke`.
- **Password reset:** responses must be identical whether or not the account exists; never send email synchronously on that path; tokens are `<id>.<secret>`, hash-only in the DB, single use, short lived. Don't add a different recovery path without the same properties.
- **Email:** send only through `MailService`. In production `MAIL_TRANSPORT` must be set explicitly (`smtp` + `SMTP_URL`); the `console` transport and `GET /api/v1/dev/outbox` are dev/test only and 404 in production. Never log message bodies in smtp mode.
- Tenants cannot create permissions; system roles are immutable; role changes invalidate the permission cache.
- Anything platform-wide (kill switch, plan matrix, tenant overrides) requires a reason and writes `flag_audit`.
- Never trust `x-outlet-id`/tenant ids from the client without the guard chain/RLS confirming access.

## Testing
- Files: `foundation.e2e-spec.ts` (RLS, auth, RBAC, flags, contract), `p0-completion.e2e-spec.ts` (sessions, devices, idempotency, hardening), `passwords.e2e-spec.ts` (change/forgot/reset password), `spike-drizzle-rls.e2e-spec.ts` (ORM spike). `test/env.ts` relaxes auth throttling for the suite.
- `test/*.e2e-spec.ts` with supertest against a real Postgres (no DB mocks — RLS can't be mocked). Tests create tenants with unique slugs, so they're re-runnable.
- Every new endpoint needs: happy path, permission/audience denial, validation failure, and — for tenant data — a cross-tenant isolation check.
- Assert the **envelope** (`success`, `error.code`, `data`, `meta.pagination`), not just the status code.
- Any change to the guard chain, RLS policies or the envelope must come with a test.
