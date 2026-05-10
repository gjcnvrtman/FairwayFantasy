// ============================================================
// MIDDLEWARE — protected-route guard, edge-runtime safe.
//
// CRITICAL: this file runs in the Edge Runtime. It cannot import
// from `@/auth` (that pulls bcrypt + kysely + pg, all Node-only).
// It uses ONLY `@/auth.config` which is bundler-safe.
//
// Behavior:
//   - Protected paths (/league/, /dashboard, /create, /settings)
//     redirect unauthenticated visitors to /auth/signin?redirect=…
//   - Authenticated visitors hitting /auth/signin or /auth/signup
//     bounce to /dashboard.
//   - Everything else passes through.
// ============================================================

import NextAuth from 'next-auth';
import { authConfig } from '@/auth.config';
import { NextResponse } from 'next/server';

// Edge-safe auth() — verifies the JWT cookie via Web Crypto, no DB,
// no Node crypto. The Credentials provider in `auth.ts` is NOT
// loaded here.
const { auth } = NextAuth(authConfig);

const PROTECTED_PREFIXES = ['/league/', '/dashboard', '/create', '/settings'];
const AUTH_PAGES         = ['/auth/signin', '/auth/signup'];

export default auth(req => {
  const { pathname } = req.nextUrl;
  const isAuthed     = !!req.auth?.user;

  const isProtected  = PROTECTED_PREFIXES.some(p => pathname.startsWith(p));
  const isAuthPage   = AUTH_PAGES.some(p => pathname.startsWith(p));

  if (isProtected && !isAuthed) {
    const url = req.nextUrl.clone();
    url.pathname = '/auth/signin';
    url.searchParams.set('redirect', pathname);
    return NextResponse.redirect(url);
  }

  if (isAuthed && isAuthPage) {
    const url = req.nextUrl.clone();
    url.pathname = '/dashboard';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
});

// Skip middleware for static assets + the NextAuth API itself
// (the catch-all route handles its own auth context).
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/).*)'],
};
