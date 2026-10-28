import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { clearSession, forwardHeaders, sameOrigin, server } from '@/lib/server';

/** Ends the session server-side (revokes the refresh token family member) and clears both cookies. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ success: false }, { status: 403 });
  const token = (await cookies()).get(server.cookieName)?.value;
  if (token) {
    await fetch(`${server.apiUrl}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...forwardHeaders(req) },
      cache: 'no-store',
    }).catch(() => undefined); // best effort: cookies are cleared regardless
  }
  const res = NextResponse.json({ success: true });
  clearSession(res);
  return res;
}
