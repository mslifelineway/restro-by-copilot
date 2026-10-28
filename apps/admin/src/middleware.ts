import { NextRequest, NextResponse } from 'next/server';

/** Pages reachable without a session. */
const PUBLIC = ['/login', '/forgot-password', '/reset-password'];

/**
 * Cheap presence check; real authorization happens in the API on every call.
 * A user with only a refresh cookie is let through: the first BFF call silently renews the session.
 */
export function middleware(req: NextRequest) {
  const has = req.cookies.has(process.env.SESSION_COOKIE_NAME ?? 'rms_admin_session')
    || req.cookies.has(process.env.REFRESH_COOKIE_NAME ?? 'rms_admin_refresh');
  const { pathname } = req.nextUrl;
  if (!has && !PUBLIC.includes(pathname)) return NextResponse.redirect(new URL('/login', req.url));
  if (has && pathname === '/login') return NextResponse.redirect(new URL('/', req.url));
  return NextResponse.next();
}

export const config = { matcher: ['/((?!api|_next|favicon.ico).*)'] };
