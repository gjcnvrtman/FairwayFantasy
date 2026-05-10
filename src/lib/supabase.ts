// ============================================================
// SUPABASE CLIENT — browser-side only (post-Phase-2)
//
// Server-side data access went to kysely in Phase 2:
//   - `db` from `@/lib/db` for direct queries
//   - `getLeagueBySlug` etc. from `@/lib/db/queries`
//
// What's left here:
//   - `createBrowserSupabaseClient` for client-side auth flows
//     (signin / signup / Nav signOut). These get replaced in
//     Phase 4 when the auth boundary swaps to golf-czar JWT.
//
// This file is intentionally browser-safe — importing `@/lib/db`
// here would pull `pg` (a Node-only driver) into client bundles.
// Bug found in Phase 2: a re-export of `db/queries` here caused
// `Module not found: tls` during `next build` because client
// components like `<Nav>` transitively followed the import chain.
// ============================================================

import { createClient } from '@supabase/supabase-js';

// ── Browser client (use in Client Components) ────────────────
export function createBrowserSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      'Supabase browser client called without env. ' +
      'Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local. ' +
      '(The public landing page does NOT require these — only auth-gated pages do.)'
    );
  }
  return createClient(url, key);
}
