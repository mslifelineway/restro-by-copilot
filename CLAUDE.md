# RMS — Restaurant Management System

Multi-tenant, offline-first SaaS. Source of truth for product scope: *RMS Master Product Document v2.0*
(phases P0–P6). **Built: P0 plus partial P1 software workflows.** P1 remains in progress; follow the user's explicit
P1 request and do not start P2+ features.

App-specific rules live next to the code — read them before editing:
- `apps/api/CLAUDE.md` — NestJS backend
- `apps/admin/CLAUDE.md` — Next.js admin / super-admin console

## Commands (run from repo root)
```bash
pnpm install
pnpm db:up                 # Postgres :5440, Redis :6390 (docker compose)
pnpm build                 # turbo: builds @rms/shared first, then apps
pnpm db:migrate && pnpm db:seed
pnpm dev                   # API on :3100
pnpm --filter @rms/admin dev   # admin on :3001
pnpm typecheck             # all packages
pnpm test                  # API e2e + printer unit tests (needs the DB up) — must pass before finishing a task
pnpm e2e                   # browser tests for the admin UI (needs DB up + `pnpm build`) — run when UI changes
```
Ports: API **3100**, admin **3001**, Postgres **5440**. (3000 is used by other projects on dev machines.)

## Structure
```
apps/api            NestJS API
apps/admin          Next.js: platform console + restaurant (tenant) admin console (BFF + UI)
packages/shared     Types/catalogs used by both: permissions, feature flags, plans, API envelope types
packages/printer    ESC/POS builder + print spooler (pure TS) and a Node-only TCP transport (`@rms/printer/tcp`)
docs/               offline-sync design, spike status, ADRs
```
Docker: `apps/api/Dockerfile`, `apps/admin/Dockerfile` (build from repo root), `docker compose --profile app up`.
Planned (do not scaffold unprompted): `apps/qr-web` (customer PWA), `packages/sdk`. `apps/pos` is an Expo POS app with
online order/billing workflows and an offline-sync spike; remaining POS/P1 gaps are documented in its README.

## Cross-cutting rules
- **Monorepo:** all apps live here. Shared code goes in `packages/shared` — never copy types between apps.
  After changing `packages/shared`, run `pnpm --filter @rms/shared build` (apps consume `dist/`; the API's jest maps to `src/`).
- **API response contract is fixed.** Success, paginated, error and validation-error shapes are defined in
  `packages/shared/src/api.ts` and implemented in `apps/api/src/common/`. Never invent another shape; never
  hand-build an envelope in a controller. Details in `apps/api/CLAUDE.md`.
- **Money** is integer paise (never floats) with a currency code. **IDs** are UUIDs. **Timestamps** are UTC ISO strings;
  display in tenant timezone in the UI.
- **Multi-tenancy is enforced by Postgres RLS**, not by remembering a `WHERE tenant_id`. Never connect the app as a
  superuser/owner role.
- **Feature flags vs permissions:** a flag says a module is available to a tenant; a permission says which user may use it.
  Core features (billing, tax, audit log, auth, basic orders/KOT) are never flagged.
- **Sessions:** access JWT 15 min + rotating refresh token. Anything that should end access (logout, disable user, revoke device, role change) must revoke sessions via `SessionService`, not just flip a flag.
- **Retries:** any client write that can be retried (POS, BFF) should send an `Idempotency-Key`; handlers must be safe to replay through the interceptor.
- **Audit:** state changes that matter (auth, role/user/outlet/plan/flag changes) write `audit_log` in the same transaction.
- Never commit `.env`. Secrets come from env only. Never log tokens, passwords, PINs or full request bodies.
- Don't add dependencies casually; check whether the stack in the product doc §5.1 already has the answer.
- Keep the phase boundaries: when a feature is deliberately deferred, record it in `docs/adr/` (Known gaps), not in code comments.

## Definition of done
Typecheck + build pass, `pnpm test` passes, new behaviour has a test (API e2e / Playwright for UI),
migrations are additive and have been applied locally, docs/CLAUDE.md updated if a rule or command changed.

## Keeping this file current
If you change a command, port, convention or contract, update the relevant CLAUDE.md in the same change.
