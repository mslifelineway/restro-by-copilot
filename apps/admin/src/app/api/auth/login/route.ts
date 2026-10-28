import { NextResponse } from 'next/server';
import { forwardHeaders, sameOrigin, server, setSession } from '@/lib/server';

/** BFF login: exchanges credentials for tokens and stores them in httpOnly cookies (never in JS). */
export async function POST(req: Request) {
  console.log('BFF login POST', req.url, req.headers.get('origin'), req.headers.get('referer'));
  if (!sameOrigin(req)) return NextResponse.json({ success: false, error: { code: 'CSRF_REJECTED', message: 'Bad origin' } }, { status: 403 });
  // { mode: 'platform', email, password }  or  { mode: 'tenant', tenantSlug, email, password }
  const { mode, ...credentials } = await req.json().catch(() => ({ mode: undefined }));
  const endpoint = mode === 'tenant' ? 'login' : 'platform/login';
  const url = `${server.apiUrl}/api/v1/auth/${endpoint}`;
  console.log(`BFF login: ${mode} -> ${url} with`, credentials);
  const upstream = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...forwardHeaders(req) },
    body: JSON.stringify(credentials),
    cache: 'no-store',
  });
  const body = await upstream.json();
  if (!upstream.ok) return NextResponse.json(body, { status: upstream.status });

  const res = NextResponse.json({ ...body, data: { kind: mode === 'tenant' ? 'tenant' : 'platform' } });
  setSession(res, body.data);
  return res;
}
