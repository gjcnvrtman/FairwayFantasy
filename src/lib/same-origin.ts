// ============================================================
// SAME-ORIGIN GUARD — belt-and-suspenders CSRF defense
//
// NextAuth's session cookie already uses SameSite=Lax, which blocks
// the classic CSRF vectors (form auto-submit, image-tag GETs).
// Cross-origin fetch with credentials is blocked by browser CORS
// since this app doesn't set permissive Access-Control-Allow-Origin
// headers. So the practical CSRF surface is already small.
//
// This helper adds an explicit Origin/Referer check on every
// state-changing API route as defense in depth. It catches:
//   * a hypothetical future regression that turns on permissive
//     CORS by mistake
//   * cross-origin attempts that LOG visibly (server returns 403,
//     so the access log captures the attempt — useful for spotting
//     scripted abuse before it works)
//
// What "same origin" means here:
//   * Same scheme + host + port as one of the configured canonical
//     site URLs
//   * Pulled from BOTH `NEXTAUTH_URL` and `NEXT_PUBLIC_SITE_URL` —
//     a reverse-proxy deployment (the LAN setup) typically has
//     NEXTAUTH_URL pointing at the internal next.js address
//     (http://192.168.1.160:3000) for NextAuth's callback math while
//     NEXT_PUBLIC_SITE_URL is the user-facing public hostname
//     (https://fairway.golf-czar.com). Both are legitimate same-
//     origin sources from the browser's perspective.
//
// Server-to-server calls (curl, systemd timers, cron jobs) typically
// have NO Origin/Referer header. Routes that legitimately need this
// path (e.g. /api/sync-scores via Bearer CRON_SECRET, /api/admin/
// reminders called by the reminder timer) must NOT use this guard —
// they enforce auth a different way. The helper fails open on
// missing Origin/Referer so those paths still work.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';

/** Cached canonical-origin set (scheme+host+port strings). */
let cachedCanonicals: Set<string> | null = null;

function canonicalOrigins(): Set<string> {
  if (cachedCanonicals !== null) return cachedCanonicals;
  const candidates = [
    process.env.NEXTAUTH_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
  ];
  const out = new Set<string>();
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const u = new URL(raw.trim());
      out.add(`${u.protocol}//${u.host}`);
    } catch {
      // Malformed URL in env — skip silently. Don't break the helper
      // if one of the two vars is mis-set; the other will still work.
    }
  }
  cachedCanonicals = out;
  return out;
}

/**
 * Returns null when the request appears to be same-origin (or when
 * we can't determine the canonical origin — fail-open in that case
 * so a misconfigured dev env doesn't break the whole app). Returns a
 * 403 NextResponse when the Origin/Referer is present and clearly
 * cross-origin.
 *
 * Pattern at call sites:
 *
 *     const csrf = requireSameOrigin(req);
 *     if (csrf) return csrf;
 *
 * Designed to be a one-line guard — never throws.
 */
export function requireSameOrigin(req: NextRequest): NextResponse | null {
  const expected = canonicalOrigins();
  if (expected.size === 0) return null;  // dev env without env vars — pass

  // Origin is the precise CSRF indicator. Browsers send it on every
  // state-changing fetch / form submit. Some same-origin GETs omit
  // it, but state-changing methods (POST/PUT/PATCH/DELETE) always
  // include it from modern browsers.
  const origin = req.headers.get('origin');
  if (origin) {
    return expected.has(origin) ? null : crossOriginRefused();
  }

  // Older browsers (or some privacy extensions) strip Origin but
  // keep Referer. Fall back to Referer's origin if present.
  const referer = req.headers.get('referer');
  if (referer) {
    try {
      const r = new URL(referer);
      const refOrigin = `${r.protocol}//${r.host}`;
      return expected.has(refOrigin) ? null : crossOriginRefused();
    } catch {
      return crossOriginRefused();
    }
  }

  // Neither Origin nor Referer present. This is the server-to-server
  // shape (curl, systemd timer). Browsers always send at least one
  // for state-changing requests. We FAIL-OPEN here so legitimate
  // tools work — but the routes that should be browser-only would
  // typically pair this guard with a session check (no anonymous
  // server-to-server call can present a valid session cookie),
  // so the net protection is still tight.
  return null;
}

function crossOriginRefused(): NextResponse {
  return NextResponse.json(
    { error: 'Cross-origin requests are not permitted on this endpoint.' },
    { status: 403 },
  );
}
