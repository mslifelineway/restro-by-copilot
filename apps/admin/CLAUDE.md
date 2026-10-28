# apps/admin — Next.js admin / super-admin console

Two consoles in one app, chosen by who signs in (the login page has a Restaurant / Platform admin switch):
- **Platform console** (`(console)` route group): tenants, plans & feature matrix, kill switch, flag history.
- **Restaurant console** (`(tenant)` route group, P0 scope): overview, settings, outlets, users (roles, PIN, disable, force sign-out), roles & permissions, devices, subscription/usage, audit log, account (change password + own sessions).
Public pages (no session): `/login`, `/forgot-password`, `/reset-password` — list them in `middleware.ts` `PUBLIC` if you add more.
Not built (later phases): menu, POS, orders, inventory screens; billing/payment screens.

## Commands
```bash
pnpm --filter @rms/admin dev        # http://localhost:3001 (needs API on :3100)
pnpm --filter @rms/admin build
pnpm --filter @rms/admin typecheck
pnpm e2e                            # Playwright browser tests (needs DB up + `pnpm build`); uses ports 3190/3191
```
Env (see `.env.example`): `API_URL`, `SESSION_COOKIE_NAME`, `REFRESH_COOKIE_NAME`, `REFRESH_MAX_AGE_SECONDS`. Server-only — never `NEXT_PUBLIC_`.
Dev login: seeded platform admin from the root `.env` (`PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD`).

## Structure
```
src/
  middleware.ts                    redirects by cookie presence (not authorization)
  app/
    layout.tsx, providers.tsx      root layout, TanStack Query provider
    login/                         public login page
    (console)/                     PLATFORM shell + pages: tenants, tenants/new, tenants/[id], features, flag-history, account
    forgot-password/, reset-password/  public recovery pages (talk to /api/auth/forgot-password|reset-password BFF routes)
    (tenant)/                      RESTAURANT shell + pages: dashboard, settings, outlets, users, roles, devices, subscription, audit-log, security
    api/auth/{login,logout}/       BFF auth: sets/clears the httpOnly session cookie
    api/bff/[...path]/             authenticated proxy -> Nest /api/*  (browser never sees the token)
  components/ui/                   shadcn-style primitives (button, input, card, badge, table)
  components/                      shell (audience guard + nav), change-password-card, modal, field, permission-editor, page-header, pagination-bar, reason-dialog, query-state
  lib/                             api.ts (typed client), server.ts (BFF-only), types.ts, utils.ts, use-me.ts
```

## Next.js conventions
- App Router, TypeScript strict. Pages are Server Components by default; add `'use client'` only when you need state, effects, or browser APIs.
  (The console pages are client components because they are interactive TanStack Query views.)
- Page files export only the default component (+ Next's reserved exports). Put helpers in `lib/` — exporting extras from `page.tsx` breaks the build.
- **All backend calls go through the BFF** (`/api/bff/...`) using `lib/api.ts`. Never call the Nest URL from the browser, never put tokens in
  `localStorage`/JS-readable cookies, never use `NEXT_PUBLIC_` for API URLs or secrets.
- Server state = TanStack Query (query keys like `['tenants', page]`; invalidate on mutation). Forms = React Hook Form + Zod resolver.
  Don't mirror server data into Zustand/useState.
- Dependency choices follow the product doc §5.1: Tailwind + shadcn/ui (Radix), TanStack Query/Table, RHF + Zod, lucide icons.
  Add shadcn-style components under `components/ui/`; don't introduce another component library.

## API contract handling
- `lib/api.ts` unwraps the fixed envelope. `api.get/post/put/patch/delete` return `data`; `api.list` returns `{ items, pagination }`.
  Failures throw `ApiError { status, code, message, details, requestId }` — branch on `code`, never on message text.
- Envelope types come from `@rms/shared` (`ApiSuccess`, `ApiErrorBody`, `Pagination`). Don't redefine them.
- `VALIDATION_FAILED` → map `details[].field` onto form fields with `applyServerErrors`; other errors show `error.message` (and `requestId` in `ErrorBox`).
- A 401 from the BFF redirects to `/login`. Mutations return `data: null` (HTTP 200).
- Hide mutation controls with `useCanWrite()` (platform) / `useCan('resource:action')` (tenant) and filter nav by `permission` in the shell — that's UX only; the API enforces roles and returns `PERMISSION_DENIED`, which pages must render via `ErrorBox`.
- `Shell` guards the audience: a platform user opening a tenant page (and vice versa) is redirected to their own console. New pages go in the right route group.
- Flag/kill-switch/override changes must go through `ReasonDialog` (the API requires a reason and audits it).

## Code style
- Small components, named exports for shared components, default export only for pages/layouts. Co-locate one-off components with their page.
- Style with Tailwind utilities + the CSS-variable tokens in `globals.css` (`bg-card`, `text-muted-foreground`, `border`…). No hard-coded hex colours in components; support light and dark (`prefers-color-scheme`).
- Use `cn()` for conditional classes. Touch-friendly sizes; semantic HTML (`button`, `label`+`htmlFor`, `role="alert"` for errors); keyboard-reachable dialogs.
- No `any`; types for API rows live in `lib/types.ts`. Money is paise → format for display only. Dates are UTC ISO → `fmtDate`.
- Avoid very new JS runtime APIs in client code (e.g. `Object.groupBy`) — use the helpers in `lib/utils.ts`.

## Environment & security
- Two cookies, both `httpOnly`, `SameSite=Strict`, `Secure` in production: the access token (lives as long as the JWT, 15 min) and the refresh token (7 days). The BFF proxy refreshes transparently when the access cookie is gone or the API answers 401, then retries once and sets the rotated cookies. Never read or write these cookies outside `lib/server.ts` helpers (`setSession`/`clearSession`).
- Public BFF routes (`forgot-password`, `reset-password`) go through `publicPost()` in `lib/server.ts` (CSRF origin check + IP forwarding). The recovery UI must show the same confirmation whether or not the account exists. A wrong current password is a field error, never a redirect to login.
- The BFF forwards `x-forwarded-for` so the API's per-IP rate limits apply per user.
- Logout calls the API (ends the session chain) and clears both cookies. Production runs from the Next `standalone` output (`apps/admin/Dockerfile`).
- BFF write routes reject cross-origin requests (`sameOrigin`). Keep that check on every new mutating route handler.
- The BFF only proxies to `API_URL/api/*`; don't add open proxies or forward arbitrary headers/cookies upstream.
- `middleware.ts` is a convenience redirect, **not** authorization. Real checks happen in the API.
- Never log tokens or request bodies. Don't expose `requestId`-less raw errors; show `ApiError.message`.
- Custom-domain/white-label later: cookies stay scoped to the exact host (no wide `Domain=`).

## Testing
- **Playwright** (`apps/admin/e2e`, config `playwright.config.ts`): drives the real built API + admin against Postgres. `global-setup.ts` creates a fresh tenant per run via the platform API. Runs on dedicated ports (API 3190, admin 3191) with relaxed rate limits so it never reuses a dev server.
- Write tests as a user would: sign in through the form, use roles/labels, assert visible outcomes. Scope locators to `getByRole('navigation')` / `getByRole('dialog')` (the overview and modals repeat labels; field labels include their hint text, so match with a regex like `/^New password/` rather than `exact`), and use the `alerts()` helper — Next's hidden route announcer also has `role=alert`.
- Wait for hydration (`waitForLoadState('networkidle')`) before typing into a freshly loaded form; the login form is `method="post"` so a pre-hydration submit can never put a password in the URL.
- Password-reset e2e reads the emailed link from `GET /api/v1/dev/outbox` (console mail transport, non-production API only).
- Every new screen needs: happy path, a validation or error path, and — where permissions differ — a check as a limited role.
- Always also run `pnpm --filter @rms/admin typecheck` and `build`. Never point the UI at production data.
