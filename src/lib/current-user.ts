// ============================================================
// AUTH BOUNDARY — single funnel for "who is the current user?"
//
// This is the ONLY file that touches the underlying auth provider.
// Every page, API route, and helper goes through `getCurrentUser()`.
//
// Why a boundary:
//   We're migrating from Supabase Cloud to a self-hosted setup
//   under golf-czar (JWT signed with shared JWT_SECRET, cookie
//   scoped to .golf-czar.com — Phase 4 of the migration).
//   Concentrating the auth read here means Phase 4 changes one
//   file, not 12.
//
// Today: implementation reads from Supabase Auth via @supabase/ssr.
// After Phase 4: implementation reads `golf-czar-token` cookie,
//   verifies JWT against JWT_SECRET, looks up the profile by
//   `profiles.golf_czar_user_id`. The shape returned to callers
//   stays the same.
// ============================================================

import { createServerSupabaseClient } from './supabase-server';

/**
 * The user identity Fairway code consumes everywhere.
 *
 * - `id` — `profiles.id` (UUID). This stays stable across the
 *   golf-czar migration: post-migration we look it up by JWT-id →
 *   `golf_czar_user_id` → `profiles.id`. So callers using `user.id`
 *   today don't have to change anything.
 * - `email` — present today; will come from JWT claims post-migration.
 * - `display_name` / `is_admin` — populated post-migration from JWT
 *   claims. Today: `display_name` is null (we'd need a profiles
 *   lookup to fill it; callers that need it already do that).
 */
export interface FairwayUser {
  id:            string;         // profiles.id UUID
  email:         string | null;
  display_name?: string | null;
  is_admin?:     boolean;
}

/**
 * Return the current user, or null if no valid session.
 * Never throws. Use this in pages where you want to inspect-then-redirect.
 */
export async function getCurrentUser(): Promise<FairwayUser | null> {
  // ── Phase 1 implementation: still Supabase Auth ──
  // The Phase 4 swap replaces this body with cookie-read + JWT-verify
  // + profile lookup. The return shape stays the same.
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  return {
    id:    user.id,
    email: user.email ?? null,
  };
}

/**
 * Whether ANY user is signed in. Equivalent to `getCurrentUser() !== null`
 * but spelled out for readability at callsites that don't need the user.
 */
export async function hasSession(): Promise<boolean> {
  return (await getCurrentUser()) !== null;
}
