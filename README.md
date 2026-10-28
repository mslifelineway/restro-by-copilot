# RMS — Restaurant Management System

Multi-tenant, offline-first, AI-ready SaaS. This repo currently contains **Phase 0 (Foundation)** from
*RMS Master Product Document v2.0*.

## Layout
```
apps/api            NestJS API (auth, RBAC, tenants, entitlements, subscription skeleton, audit)
apps/admin          Next.js admin: platform console (tenants, features & plans, flag history) + restaurant console (settings, outlets, users, roles, devices, subscription, audit log)
packages/shared     Permission catalog, feature-flag catalog, plans, API envelope types
packages/printer    ESC/POS builder, print spooler with retry, LAN transport (hardware not yet validated)
docs/               offline-sync design, tech-spike status, ADRs
```

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

## API surface (P0)
| Area | Routes |
|---|---|
| Auth | `POST /v1/auth/login`, `/pin-login`, `/platform/login` (return access + refresh token), `/refresh`, `/logout`, `/logout-all`, `/change-password`, `/forgot-password`, `/reset-password`; `GET /v1/auth/me` |
| Platform (super admin / support) | `/v1/platform/tenants` (create, list, get, `PATCH :id/status`, `PATCH :id/plan`), `/plans`, `/features`, `PUT /features/:key/kill-switch`, `PUT /plans/:plan/features/:key`, `GET|PUT|DELETE /tenants/:id/features/:key`, `/flag-history` |
| Tenant | `/v1/tenant`, `/outlets` (+ `PATCH`/`DELETE :id`), `/users` (+ `PATCH :id`, `POST :id/force-logout`), `/roles`, `/devices` (register, list, `POST :id/revoke`), `/sessions`, `/subscription`, `/audit-log`, `/entitlements` |

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
