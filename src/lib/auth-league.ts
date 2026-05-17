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
import { getCurrentUser } from './current-user';
import { db } from './db';

// Pure decision helpers live in auth-decisions.ts so unit tests can
// import them without pulling in NextAuth / pg. Re-export here so
// existing callers don't change.
export {
  decideCommissionerAuth,
  decideMemberAuth,
  wouldOrphanLeague,
  type AuthDecision,
  type Role,
} from './auth-decisions';

import type { Role } from './auth-decisions';

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
  // Goes through the central boundary so the golf-czar swap (Phase 4)
  // touches one file. Returns null when no session.
  const user = await getCurrentUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }),
    };
  }

  // ── Look up league ──
  // We trust the caller's identifier; either path returns the same row.
  let leagueQuery = db.selectFrom('leagues').selectAll();
  if (leagueId) leagueQuery = leagueQuery.where('id',   '=', leagueId);
  else          leagueQuery = leagueQuery.where('slug', '=', slug!);
  const league = await leagueQuery.executeTakeFirst();
  if (!league) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'League not found' }, { status: 404 }),
    };
  }

  // ── Membership check ──
  const membership = await db.selectFrom('league_members')
    .select('role')
    .where('league_id', '=', league.id)
    .where('user_id', '=', user.id)
    .executeTakeFirst();

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

/**
 * Same shape as ``requireCommissioner`` but accepts any league member
 * (commissioner or rank-and-file). Use for actions that any member
 * should be able to do — currently invite-by-email, which mirrors the
 * link-copy button shown to everyone in the league sidebar.
 *
 * Status codes match the commissioner helper for consistency:
 *   400 — neither slug nor leagueId provided
 *   401 — no session
 *   404 — league doesn't exist OR user isn't a member of it
 *         (conflated so we don't leak league existence to non-members)
 */
export async function requireMember(args: {
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

  const user = await getCurrentUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }),
    };
  }

  let leagueQuery = db.selectFrom('leagues').selectAll();
  if (leagueId) leagueQuery = leagueQuery.where('id',   '=', leagueId);
  else          leagueQuery = leagueQuery.where('slug', '=', slug!);
  const league = await leagueQuery.executeTakeFirst();
  if (!league) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'League not found' }, { status: 404 }),
    };
  }

  const membership = await db.selectFrom('league_members')
    .select('role')
    .where('league_id', '=', league.id)
    .where('user_id', '=', user.id)
    .executeTakeFirst();

  if (!membership) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'League not found' }, { status: 404 }),
    };
  }

  return {
    ok: true,
    user: { id: user.id },
    league: league as LeagueRow,
    role: membership.role,
  };
}

// (Pure decision helpers — `decideCommissionerAuth`, `decideMemberAuth`,
// `wouldOrphanLeague` — are imported above from `./auth-decisions`
// and re-exported. They live there so unit tests can import them
// without pulling NextAuth / pg / kysely into Vitest's bundle.)
