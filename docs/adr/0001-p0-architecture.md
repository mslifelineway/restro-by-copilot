# ADR-0001: P0 architecture choices

Status: accepted (P0)

## Decisions
1. **Modular monolith**: one NestJS app (`apps/api`), modules per concern (`auth`, `platform`, `tenant`, `entitlements`, `audit`). Split later on need.
2. **Tenancy**: shared DB, `tenant_id` on every tenant table, **PostgreSQL RLS with FORCE**. The API connects as `rms_app` (no superuser, no BYPASSRLS); migrations run as the owner role. Each transaction sets `app.tenant_id` / `app.is_platform` with `set_config(..., true)` so settings cannot leak through the connection pool.
3. **Platform context**: `app.is_platform = 'true'` lets super-admin/support and login lookups cross tenants. It is only set by code paths guarded by `@PlatformOnly` or the login flow.
4. **Guard chain** (global): Auth -> Audience (platform/tenant) -> Feature (`@RequireFeature`) -> Permission (`@RequirePermission`). RLS is the last safety net.
5. **Entitlements**: resolution order global kill switch > outlet override > tenant override > plan default, then dependency pass. Overrides need a reason, may expire, and every change goes to the append-only `flag_audit`.
6. **Auth (P0)**: local email/password + POS PIN, scrypt hashes, lockout after 5 failures (15 min), HS256 access tokens. The doc's final pick is **Auth0 + BFF cookie for admin web**; that needs an Auth0 tenant and the Next.js admin app, so it is deferred. Token verification sits behind `AuthGuard`, so swapping the verifier is local to `auth/`.
7. **Permissions**: fixed catalog in `@rms/shared` (resource:action), tenant-defined roles, assignments scoped tenant-wide or per outlet, limits JSON (e.g. `maxPercent`). Resolved server-side and cached per process for 5 s (Redis planned when running multiple instances).
8. **Money** is integer paise; **IDs** are UUIDs; timestamps UTC; soft delete via `deleted_at`; `version` bumped by trigger.

9. **Response contract**: fixed success/error/validation envelope (`packages/shared/src/api.ts`), applied globally by an interceptor, an exception filter and a validation pipe. Expected failures throw `AppException` with a stable domain code.
10. **Admin web**: Next.js BFF pattern. The browser holds only an httpOnly SameSite=Strict cookie; `/api/bff/*` adds the bearer token and proxies to the API.

11. **Sessions**: short-lived access JWT (15 min) + rotating refresh token (7 days, `sessions` table, only a hash stored). Reuse of a rotated token outside a 10 s leeway revokes the whole rotation chain; logout, force-logout, user-disable and device-revoke end sessions within ~5 s. Devices (`devices`) are registered per tenant and can be bound to a session at login.
12. **Idempotency**: `Idempotency-Key` header honoured on authenticated writes (replay / mismatch / in-progress handling, 24 h TTL). Any new write endpoint gets this for free.
13. **Hardening**: helmet headers, per-IP rate limiting (stricter on auth routes), generic auth errors, trust-proxy configured via env.
14. **Admin UI**: one Next.js app, two consoles. Platform console (tenants, flags) and restaurant console (settings, outlets, users, roles, devices, subscription, audit, sessions) share the BFF; the shell guards each audience. Verified by Playwright browser tests.
15. **Passwords**: change-password needs the current password, shares the login lockout counter, answers 400 (not 401) on a wrong password so clients don't treat it as an expired session, and ends all other sessions. Forgot-password never reveals whether an account exists, emails a single-use 30-minute link (hash stored; max 3/hour/account; a newer link voids older ones), and a successful reset ends every session and clears any lockout. Email goes through `MailService` (console transport for dev/test, SMTP in production; `MAIL_TRANSPORT` must be set explicitly in production).
16. **Docker/CI**: Dockerfiles for API and admin, a compose profile for the full stack, CI builds both images.

## Known gaps vs. the product doc (intentionally not in P0)
- **Auth0 / SSO / MFA**: needs an Auth0 tenant (and, for MFA, an enrolment UX). Token verification is isolated in `AuthGuard`, so the swap is local to `auth/`.
- **API keys per tenant** (M2 advanced; needed with the public API in P3).
- **Approval workflows**: permission *limits* are stored and returned (e.g. `maxPercent`) but manager-approval is not enforced; it needs the POS flows from P1.
- **Redis-backed caches, BullMQ workers**: per-process 5 s caches are enough for one API instance; move to Redis when running several.
- **First-login setup checklist** (M23, P2), self-service email change, and a way for PIN-only users to set a first password without an admin (they can use forgot-password).
- **Real email delivery is untested**: the SMTP transport is implemented (nodemailer) but only the console transport has been exercised; verify with the real provider (e.g. SES SMTP) before launch.
- **Razorpay/Stripe, proration, dunning**: subscription is a skeleton (plan, status, trial, period).
- **Schema-per-tenant / DB-per-tenant** isolation modes (shared DB + RLS only).
- **React Native POS spike and printer hardware validation**: need devices (see `docs/spikes.md`).
- **Docker images were not built in the authoring sandbox** (no DNS inside Docker there). The production dependency tree + compiled output was verified to boot; CI's `docker-images` job is the first real image build.
