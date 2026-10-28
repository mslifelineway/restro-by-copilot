# RMS — Restaurant Management System

Multi-tenant, offline-first, AI-ready SaaS. This repo contains **Phase 0 (Foundation)** and implemented **Phase 1 API/data-model slices** from
*RMS Master Product Document v2.0*.

## Layout
```
apps/api            NestJS API (auth, RBAC, tenants, entitlements, subscription skeleton, audit)
apps/admin          Next.js admin: platform console (tenants, features & plans, flag history) + restaurant console (settings, outlets, users, roles, devices, subscription, audit log)
packages/shared     Permission catalog, feature-flag catalog, plans, API envelope types
packages/printer    ESC/POS builder, print spooler with retry, LAN transport (hardware not yet validated)
docs/               offline-sync design, tech-spike status, ADRs
```

Implemented P1 software slices cover M4 menu/tax catalog and CSV exchange, M6 floor/table management, M7 orders/KOT and printer dispatch, M5 billing/payment corrections and item-quantity split/merge, M10 inventory/recipes/purchasing/receiving, M16 cashier shifts and daily sales reporting, and the server-side offline sync inbox/master-data change feed. The restaurant admin provides menu/tax, floor, inventory/recipe, billing, shift and report screens, including browser-based invoice reprinting and outlet billing settings. The Expo POS supports catalog-backed online order entry with modifiers, hold/resume, KOT submission, table transfers/joins, per-order waiter assignment, invoice finalization, payments, bill discounts, tips, same-outlet unbilled-order bill merging, and quantity-based bill splitting; its offline outbox remains a manual-review spike. CSV import is atomic and merges by same-outlet item ID or SKU without deleting omitted rows. Invoice prices and service charges are tax-inclusive; discounts reduce the pre-GST taxable consideration, tips are shown separately and excluded from GST, and invoice totals round to the nearest rupee. Invoice numbering remains gapless per outlet/financial year/series. Voids and refunds are immutable compensating records; a paid invoice must be fully refunded before it can be voided. Stock uses append-only ledger events and fixed milli-units; KOT consumption is atomic with kitchen dispatch, skips items without recipes, and may take balances negative. Purchase receipts update stock in the same transaction. Cashier expected cash accounts for payments, cash refunds, and audited drawer adjustments. Remaining acceptance includes physical printer/device verification; the RMS Master Product Document is not present in this repository, so the full P1 checklist cannot be independently revalidated here. Offline sync projection/reconciliation and full-day offline authorization belong to later roadmap work. Printer jobs are routed by menu category and polled/acknowledged by a client; server acknowledgement does not prove a physical print completed.

## Quick start
Use Node 22 LTS for local development. On Windows, Node 24 can trigger V8 allocator / paging-file failures while starting Next.js dev servers.

```bash
cp .env.example .env
corepack enable
corepack prepare pnpm@10.22.0 --activate
pnpm install
pnpm db:up            # Postgres on :5440, Redis on :6390
pnpm build            # builds @rms/shared first
pnpm db:migrate       # as owner role; also creates the rms_app role
pnpm db:seed          # plans, feature catalog, platform super admin
pnpm dev              # API: http://localhost:3100
pnpm --filter @rms/admin dev   # Admin: http://localhost:3001 — "Platform admin" tab with the seeded admin, or "Restaurant" tab with a tenant's owner
pnpm e2e                       # Playwright browser tests (needs DB + `pnpm build`)
pnpm test             # API e2e (tenant isolation, sessions, idempotency, ...) + printer unit tests; needs the DB
```

## First calls
```bash
# platform login (seeded from PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD)
curl -s localhost:3100/api/v1/auth/platform/login -H 'content-type: application/json' \
  -d '{"email":"admin@rms.local","password":"ChangeMe123!"}'   # token is at .data.accessToken

# onboard a tenant (creates tenant, subscription, first outlet, system roles, owner)
curl -s localhost:3100/api/v1/platform/tenants -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Cafe One","slug":"cafe-one","planCode":"growth","ownerName":"Asha","ownerEmail":"asha@cafe.test","ownerPassword":"a-long-password"}'

# tenant login
curl -s localhost:3100/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"tenantSlug":"cafe-one","email":"asha@cafe.test","password":"a-long-password"}'
```

## Response format
All endpoints return a fixed envelope (`success`, `statusCode`, `message`, `data`, `timestamp`, `path`, `requestId`; lists add
`meta.pagination`; errors return `error { code, message, details? }`). Routes are under `/api/v1/...` (`/health` is unprefixed).
See `apps/api/CLAUDE.md`.

## API surface (P0 + implemented P1 M4/M5/M6/M7/M10/M16 slices)
| Area | Routes |
|---|---|
| Auth | `POST /v1/auth/login`, `/pin-login`, `/platform/login` (return access + refresh token), `/refresh`, `/logout`, `/logout-all`, `/change-password`, `/forgot-password`, `/reset-password`; `GET /v1/auth/me` |
| Platform (super admin / support) | `/v1/platform/tenants` (create, list, get, `PATCH :id/status`, `PATCH :id/plan`), `/plans`, `/features`, `PUT /features/:key/kill-switch`, `PUT /plans/:plan/features/:key`, `GET|PUT|DELETE /tenants/:id/features/:key`, `/flag-history` |
| Tenant | `/v1/tenant`, `/outlets` (+ `PATCH`/`DELETE :id`), `/users` (+ `PATCH :id`, `POST :id/force-logout`), `/roles`, `/devices` (register, list, `POST :id/revoke`), `/sessions`, `/subscription`, `/audit-log`, `/entitlements` |
| Menu + tax (P1 M4 API) | `/v1/menu/categories`, `/v1/menu/items`, `/v1/menu/items/:id/variants`, `/v1/menu/items/:id/add-on-groups`, `/v1/menu/add-on-groups` (+ `/add-ons`), `/v1/menu/variants/:id/price` (+ channel override), `/v1/menu/import`, `/v1/menu/export`, `/v1/tax-slabs`. Menu catalog and prices require the selected outlet via `x-outlet-id`; tax slabs are tenant-scoped. |
| Floor tables (P1 M6 API) | `/v1/floor/tables` (list, create, update, soft-delete, validated state changes, and active-order timer data). Dine-in orders can be transferred between tables or join/unjoin available tables. Requires the selected outlet via `x-outlet-id`. |
| Orders + KOT (P1 M7 API) | `/v1/orders` (create/list/get/cancel), `GET /v1/orders/waiters`, `PUT /v1/orders/:id/waiter`, `POST /v1/orders/:id/hold`, `/resume`, `/transfer-table`, `/merge-tables`, `/unmerge-tables`, `/v1/orders/:id/kot`, `/v1/orders/kot/queue`, and `/v1/orders/kot/:id/status`. Item prices and tax rates are snapshotted when ordered; KOT status is a kitchen workflow, not a printer delivery confirmation. |
| Printer dispatch (P1 M7 API) | `/v1/printer/stations` (manage stations and category routes), `/v1/printer/stations/:id/jobs/claim`, `/v1/printer/jobs/:id/status`, and `/v1/printer/jobs/:id/retry`. KOT creation transactionally queues routed items; an authenticated outlet client claims a leased job, prints locally, then acknowledges success/failure. |
| Billing (P1 M5 API) | `GET|PUT /v1/billing/settings`, `POST /v1/orders/:id/invoice`, `POST /v1/orders/:id/merge`, `POST /v1/orders/:id/invoices/split`, `GET /v1/invoices/:id`, `POST /v1/invoices/:id/payments`, `/v1/invoices/:id/refunds`, and `/v1/invoices/:id/void`. Discounts can be percentage or fixed, are permission-limited, and reduce taxable consideration proportionally before GST; configured service charges are allocated across split checks, optional tips are non-taxable, and each invoice rounds its payable amount to the nearest rupee. Merges are limited to same-outlet, same-type, ready, unbilled orders. Split checks assign every unbilled item quantity exactly once. Voids require zero net payments; refunds are capped at each payment's unrefunded amount and recorded as append-only compensating events. |
| Inventory and purchasing (P1 M10 API) | `/v1/inventory/items`, `/items/:id/movements`, `/recipes/:menuItemId`, `/v1/purchasing/suppliers`, `/v1/purchasing/orders`, order receipts, and order cancellation. PO receipt lines cannot exceed ordered quantities and update append-only stock ledger entries atomically. |
| Cashier shifts (P1 M16 API) | `/v1/cashier-shifts/current`, `POST /v1/cashier-shifts`, `/v1/cashier-shifts/:id`, `/v1/cashier-shifts/:id/close`, `/v1/cashier-shifts/:id/adjustments`, and paginated `/v1/cashier-shifts/report`. Cash payments/refunds and audited drawer adjustments are included in close reconciliation. |
| Daily sales (P1 M16 API) | `GET /v1/reports/daily-sales?date=YYYY-MM-DD` groups outlet-local business-date invoices by item/category and tax, and payments/refunds by method and cashier. |
| Offline sync (P1 server API) | `POST /v1/sync/push`, `GET /v1/sync/pull?since=...`, `GET /v1/sync/events`, and `POST /v1/sync/events/:id/resolve`. Push is device-bound and sequence-idempotent but records inbox events without applying them to orders/payments; pull returns versioned master-data changes with a commit-ordered cursor. |

Support agents are read-only on the platform API; mutating routes require `super_admin`.

## Sessions, devices, idempotency
- Login returns `{ accessToken, refreshToken, expiresIn }`. Call `POST /api/v1/auth/refresh` with the refresh token before the access token expires; it rotates (the old one stops working).
- POS apps may pass `deviceId` at login (a registered, active device); revoking a device ends its sessions.
- Send an `Idempotency-Key` header (8-128 chars) on writes you may retry; the second call replays the first result (`Idempotent-Replayed: true`).
- Auth routes are rate-limited per IP (`THROTTLE_AUTH_PER_MIN`, default 10). Behind a proxy set `TRUST_PROXY`.

## Password recovery
- Signed in: **Account** page → change password (needs the current one; your other sessions are signed out).
- Forgot: `/forgot-password` emails a single-use link (30 min). Dev: with `MAIL_TRANSPORT=console` the email is printed in the API log and readable at `GET /api/v1/dev/outbox?to=<email>`. Production: set `MAIL_TRANSPORT=smtp`, `SMTP_URL`, `MAIL_FROM`, `ADMIN_URL`.

## Docker
```bash
docker compose --profile app up --build     # db + api + admin
docker compose run --rm api node dist/db/migrate.js && docker compose run --rm api node dist/db/seed.js
```

## Security model in one paragraph
The API connects as a non-superuser DB role, so PostgreSQL RLS applies to every query. Each request runs in a
transaction with `app.tenant_id` set; forgetting a `WHERE tenant_id` cannot leak data. Guards enforce
auth -> audience -> feature entitlement -> permission. See `docs/adr/0001-p0-architecture.md`.

## What is not done yet
See "Known gaps" in the ADR and `docs/spikes.md` (POS framework and printer spikes need devices/hardware).
