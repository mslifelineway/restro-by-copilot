import 'server-only';
import { NextResponse } from 'next/server';

/** Server-only settings for the BFF. Never expose these through NEXT_PUBLIC_ vars. */
export const server = {
  apiUrl: process.env.API_URL ?? 'http://localhost:3100',
  cookieName: process.env.SESSION_COOKIE_NAME ?? 'rms_admin_session',
  refreshCookieName: process.env.REFRESH_COOKIE_NAME ?? 'rms_admin_refresh',
  refreshMaxAge: Number(process.env.REFRESH_MAX_AGE_SECONDS ?? 7 * 24 * 3600),
};

const base = { httpOnly: true, sameSite: 'strict' as const, secure: process.env.NODE_ENV === 'production' };

export interface Tokens { accessToken: string; refreshToken: string; expiresIn: number }

/**
 * Access-token cookie lives as long as the token; the refresh-token cookie lives for the session
 * (7 days by default). Both are httpOnly, so page JavaScript never sees either.
 */
export function setSession(res: NextResponse, t: Tokens) {
  res.cookies.set({ ...base, name: server.cookieName, value: t.accessToken, path: '/', maxAge: t.expiresIn });
  res.cookies.set({ ...base, name: server.refreshCookieName, value: t.refreshToken, path: '/', maxAge: server.refreshMaxAge });
}

export function clearSession(res: NextResponse) {
  res.cookies.set({ ...base, name: server.cookieName, value: '', path: '/', maxAge: 0 });
  res.cookies.set({ ...base, name: server.refreshCookieName, value: '', path: '/', maxAge: 0 });
}

/** CSRF defence for cookie-authenticated writes: Origin must match our own host. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true; // non-browser or same-origin GET
  return new URL(origin).host === req.headers.get('host');
}

/** Pass the browser's IP upstream so the API's per-IP rate limits apply per user, not per BFF. */
export const forwardHeaders = (req: Request): Record<string, string> => {
  const xff = req.headers.get('x-forwarded-for');
  return xff ? { 'x-forwarded-for': xff } : {};
};

/** Exchanges a refresh token for a new pair. Returns null if the API rejects it. */
export async function refreshTokens(req: Request, refreshToken: string): Promise<Tokens | null> {
  const r = await fetch(`${server.apiUrl}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...forwardHeaders(req) },
    body: JSON.stringify({ refreshToken }),
    cache: 'no-store',
  });
  if (!r.ok) return null;
  return (await r.json()).data as Tokens;
}

/** Forwards an unauthenticated JSON POST (forgot/reset password) to the API, after the CSRF origin check. */
export async function publicPost(req: Request, apiPath: string): Promise<Response> {
  if (!sameOrigin(req)) return NextResponse.json({ success: false, error: { code: 'CSRF_REJECTED', message: 'Bad origin' } }, { status: 403 });
  const upstream = await fetch(`${server.apiUrl}/api/v1/auth/${apiPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...forwardHeaders(req) },
    body: await req.text(),
    cache: 'no-store',
  });
  return new NextResponse(await upstream.text(), { status: upstream.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
