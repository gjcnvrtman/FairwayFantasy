import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

// Note: this middleware reads Supabase Auth directly rather than going
// through `@/lib/current-user` because middleware does provider-specific
// session-refresh cookie work (refresh tokens land here on rotation).
// The Phase-4 golf-czar swap will rewrite this file end-to-end —
// different cookie name, no refresh dance, same protected-route logic.

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  // Graceful degradation when Supabase env isn't configured (e.g. running
  // ``npm run dev`` against a fresh clone with no .env.local, or the LAN
  // deployment that's still being migrated off Supabase per prompt-1 P0).
  // Without this guard the SDK throws "Your project's URL and Key are
  // required" on every request and the app refuses to load — including
  // the public landing page that doesn't actually need auth.
  const url    = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Let the request through. Pages that DO need auth will surface their
    // own clearer error when they try to query — see also the lazy admin
    // client in src/lib/supabase.ts.
    return supabaseResponse;
  }

  const supabase = createServerClient(
    url,
    anonKey,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // Protected routes — redirect to signin if not authed
  const protectedPrefixes = ['/league/', '/dashboard', '/create'];
  const isProtected = protectedPrefixes.some(p => pathname.startsWith(p));

  if (isProtected && !user) {
    const url = request.nextUrl.clone();
    url.pathname = '/auth/signin';
    url.searchParams.set('redirect', pathname);
    return NextResponse.redirect(url);
  }

  // Already signed in — skip auth pages
  if (user && (pathname.startsWith('/auth/signin') || pathname.startsWith('/auth/signup'))) {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/).*)'],
};
