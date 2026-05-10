// ============================================================
// LEAGUE AUTHORIZATION HELPERS
//
// Single source of truth for "is this person allowed to do X to
// this league?" decisions. The actual Supabase calls live here so
// every commissioner-only API route has identical auth semantics
// — copy-pasted role checks were the surface area for bug #4.1
// (cron secret in the client bundle) and similar.
// ============================================================

import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from './supabase-server';
import { supabaseAdmin } from './supabase';

export type Role = 'commissioner' | 'member';

export interface LeagueRow {
  id:              string;
  slug:            string;
  invite_code:     string;
  commissioner_id: string;
  max_players:     number;
  name:            string;
  created_at:      string;
}

export type LeagueAuthOk   = { ok: true;  user: { id: string }; league: LeagueRow; role: Role };
export type LeagueAuthFail = { ok: false; response: NextResponse };
export type LeagueAuthResult = LeagueAuthOk | LeagueAuthFail;

/** Type guard for narrowing — TS's `strict: false` config stops the
 *  built-in `if (!auth.ok)` discriminated-union narrowing, so callers
 *  can use this guard explicitly. */
export function isAuthFail(r: LeagueAuthResult): r is LeagueAuthFail {
  return r.ok === false;
}

/**
 * Given either a league slug OR a league id, verify the current
 * session belongs to a commissioner of that league. Returns either
 *   `{ ok: true, user, league, role }`            — caller proceeds, OR
 *   `{ ok: false, response }`                     — caller `return response`
 *
 * Why a tagged union rather than throwing: route handlers want to
 * return `NextResponse.json(...)` rather than throw, and we want
 * 401 vs 403 vs 404 to be deterministic.
 *
 * Status code matrix:
 *   401 — no session
 *   400 — neither slug nor leagueId provided
 *   404 — league doesn't exist OR user isn't a member of it
 *         (we conflate "doesn't exist" with "not a member" so we
 *          don't leak league existence to non-members)
 *   403 — user is a member but not a commissioner
 */
export async function requireCommissioner(args: {
  slug?:     string | null;
  leagueId?: string | null;
}): Promise<LeagueAuthResult> {
  const { slug, leagueId } = args;
  if (!slug && !leagueId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Missing league identifier (slug or leagueId).' },
        { status: 400 },
      ),
    };
  }

  // ── Auth check ──
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }),
    };
  }

  // ── Look up league (admin client so RLS doesn't hide it) ──
  let leagueQuery = supabaseAdmin.from('leagues').select('*');
  if (leagueId) leagueQuery = leagueQuery.eq('id', leagueId);
  else          leagueQuery = leagueQuery.eq('slug', slug);
  const { data: league } = await leagueQuery.single();
  if (!league) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'League not found' }, { status: 404 }),
    };
  }

  // ── Membership check ──
  const { data: membership } = await supabaseAdmin
    .from('league_members')
    .select('role')
    .eq('league_id', league.id)
    .eq('user_id', user.id)
    .single();

  if (!membership) {
    // Non-member: respond 404 (don't leak the league's existence).
    return {
      ok: false,
      response: NextResponse.json({ error: 'League not found' }, { status: 404 }),
    };
  }

  if (membership.role !== 'commissioner') {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Only the league commissioner can perform this action.' },
        { status: 403 },
      ),
    };
  }

  return {
    ok: true,
    user: { id: user.id },
    league: league as LeagueRow,
    role: 'commissioner',
  };
}

// ── Pure decision logic (testable without DB) ────────────────

/**
 * Pure: given the inputs (session user, league row, membership row),
 * compute what the auth check should return. Used by tests so we can
 * cover all the branches without a Supabase server. Real callers go
 * through `requireCommissioner`.
 */
export type AuthDecision =
  | { code: 200 }
  | { code: 400; reason: 'no-identifier' }
  | { code: 401; reason: 'unauthenticated' }
  | { code: 403; reason: 'not-commissioner' }
  | { code: 404; reason: 'no-league-or-not-member' };

export function decideCommissionerAuth(input: {
  hasIdentifier: boolean;
  user:          { id: string } | null;
  league:        { id: string } | null;
  membership:    { role: Role } | null;
}): AuthDecision {
  if (!input.hasIdentifier)        return { code: 400, reason: 'no-identifier' };
  if (!input.user)                 return { code: 401, reason: 'unauthenticated' };
  if (!input.league)               return { code: 404, reason: 'no-league-or-not-member' };
  if (!input.membership)           return { code: 404, reason: 'no-league-or-not-member' };
  if (input.membership.role !== 'commissioner')
                                   return { code: 403, reason: 'not-commissioner' };
  return { code: 200 };
}

export function decideMemberAuth(input: {
  hasIdentifier: boolean;
  user:          { id: string } | null;
  league:        { id: string } | null;
  membership:    { role: Role } | null;
}): AuthDecision {
  if (!input.hasIdentifier)        return { code: 400, reason: 'no-identifier' };
  if (!input.user)                 return { code: 401, reason: 'unauthenticated' };
  if (!input.league)               return { code: 404, reason: 'no-league-or-not-member' };
  if (!input.membership)           return { code: 404, reason: 'no-league-or-not-member' };
  return { code: 200 };
}

// ── Last-commissioner guard ──────────────────────────────────

/**
 * Returns true if the proposed removal of this user from this league
 * would leave the league with zero commissioners — i.e. the action
 * MUST be blocked.
 *
 * Pure: takes the current member list. Caller fetches it.
 */
export function wouldOrphanLeague(input: {
  members:    Array<{ user_id: string; role: Role }>;
  removeUserId: string;
}): boolean {
  const remaining = input.members.filter(m => m.user_id !== input.removeUserId);
  return !remaining.some(m => m.role === 'commissioner');
}
