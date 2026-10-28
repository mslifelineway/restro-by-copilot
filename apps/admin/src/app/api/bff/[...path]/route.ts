import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { clearSession, forwardHeaders, refreshTokens, sameOrigin, server, setSession, type Tokens } from '@/lib/server';

const unauthorized = (code = 'AUTH_TOKEN_MISSING') =>
  NextResponse.json({ success: false, statusCode: 401, error: { code, message: 'Not signed in' } }, { status: 401 });

/**
 * Authenticated pass-through to the Nest API. The browser only ever holds httpOnly cookies; this
 * handler turns the access cookie into a bearer token and, when it has expired (or the API says the
 * token is no longer valid), transparently rotates the refresh token and retries once.
 * Everything under /api/bff/* maps to /api/* upstream.
 */
async function proxy(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  if (req.method !== 'GET' && !sameOrigin(req)) {
    return NextResponse.json({ success: false, error: { code: 'CSRF_REJECTED', message: 'Bad origin' } }, { status: 403 });
  }
  const jar = await cookies();
  let access = jar.get(server.cookieName)?.value;
  const refresh = jar.get(server.refreshCookieName)?.value;
  let rotated: Tokens | null = null;

  const rotate = async () => {
    rotated = refresh ? await refreshTokens(req, refresh) : null;
    access = rotated?.accessToken;
    return !!rotated;
  };

  if (!access && !(await rotate())) {
    const res = unauthorized();
    if (refresh) clearSession(res); // refresh token is dead: drop it so the middleware sends the user to /login
    return res;
  }

  const { path } = await params;
  const url = new URL(req.url);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const body = hasBody ? await req.text() : undefined;
  const call = () => fetch(`${server.apiUrl}/api/${path.join('/')}${url.search}`, {
    method: req.method,
    headers: {
      authorization: `Bearer ${access}`,
      ...forwardHeaders(req),
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(req.headers.get('x-request-id') ? { 'x-request-id': req.headers.get('x-request-id')! } : {}),
      ...(req.headers.get('idempotency-key') ? { 'idempotency-key': req.headers.get('idempotency-key')! } : {}),
    },
    body,
    cache: 'no-store',
  });

  let upstream = await call();
  if (upstream.status === 401 && !rotated && (await rotate())) upstream = await call();

  const res = new NextResponse(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
  if (rotated) setSession(res, rotated);
  else if (upstream.status === 401) clearSession(res);
  return res;
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
