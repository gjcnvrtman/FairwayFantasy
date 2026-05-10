// ============================================================
// AUTH BOUNDARY — single funnel for "who is the current user?"
//
// Phase 4 swap: implementation now reads from NextAuth's session
// (JWT-backed cookie). The return shape is unchanged — every page,
// route, and helper that calls `getCurrentUser()` keeps working.
//
// Why a boundary file at all:
//   Phase 1 introduced this funnel so the auth-provider swap could
//   happen in one file. Confirmed in Phase 4 — only this body had
//   to change.
// ============================================================

import { auth } from '@/auth';

/**
 * The user identity Fairway code consumes everywhere.
 *
 * - `id` — `profiles.id` (UUID). Stable identity across sessions.
 * - `email` — populated from the session.
 * - `display_name` — set from `profiles.display_name` at sign-in
 *   time (NextAuth jwt callback writes it onto the token).
 */
export interface FairwayUser {
  id:            string;         // profiles.id UUID
  email:         string | null;
  display_name?: string | null;
  is_admin?:     boolean;        // future hook; not populated today
}

/**
 * Return the current user, or null if no valid session.
 * Never throws. Use this in pages where you want to inspect-then-redirect.
 */
export async function getCurrentUser(): Promise<FairwayUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  return {
    id:           session.user.id,
    email:        session.user.email ?? null,
    display_name: session.user.name ?? null,
  };
}

/**
 * Whether ANY user is signed in. Equivalent to `getCurrentUser() !== null`.
 */
export async function hasSession(): Promise<boolean> {
  return (await getCurrentUser()) !== null;
}
