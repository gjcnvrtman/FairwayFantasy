// ============================================================
// QUERY HELPERS — kysely-flavored. Re-export point for the
// `getLeagueBySlug` / `getActiveTournament` / etc. helpers that
// used to live in `src/lib/supabase.ts`.
//
// Shape parity with the old supabase-js helpers: when the supabase-js
// `.select('*, profile:profiles(*)')` syntax built a nested object
// per row, we use `jsonObjectFrom` here so callsites that read
// `member.profile?.display_name` etc. keep working unchanged.
// ============================================================

import { db } from './index';
import { jsonObjectFrom } from 'kysely/helpers/postgres';

// ── leagues ──────────────────────────────────────────────────

export async function getLeagueBySlug(slug: string) {
  return await db.selectFrom('leagues')
    .selectAll()
    .where('slug', '=', slug)
    .executeTakeFirst() ?? null;
}

// ── league_members (with embedded profile, matching old shape) ─

export async function getLeagueMembers(leagueId: string) {
  return await db.selectFrom('league_members')
    .selectAll('league_members')
    .select(eb => jsonObjectFrom(
      eb.selectFrom('profiles')
        .selectAll('profiles')
        .whereRef('profiles.id', '=', 'league_members.user_id'),
    ).as('profile'))
    .where('league_id', '=', leagueId)
    .execute();
}

// ── tournaments ──────────────────────────────────────────────

export async function getActiveTournament() {
  // Time-based, not status-based. The rankings sync was supposed to flip
  // `upcoming` → `active` when start_date arrived, but if that timer
  // hasn't run (or hasn't run yet today), the row is still `upcoming`
  // even when play is live. Mirrors the filter `runScoreSync` already
  // uses (`src/lib/sync.ts:60`) so the two helpers agree on what
  // "active right now" means regardless of stored status drift.
  const now       = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return await db.selectFrom('tournaments')
    .selectAll()
    .where('start_date', '<=', now.toISOString())
    .where('end_date',   '>=', oneDayAgo.toISOString())
    .where('status', '!=', 'complete')
    .orderBy('start_date', 'asc')
    .limit(1)
    .executeTakeFirst() ?? null;
}

export async function getUpcomingTournaments(limit = 5) {
  return await db.selectFrom('tournaments')
    .selectAll()
    .where('status', '=', 'upcoming')
    .orderBy('start_date', 'asc')
    .limit(limit)
    .execute();
}

// ── Timestamp adapter ────────────────────────────────────────
// pg-node returns TIMESTAMPTZ values as JavaScript `Date` objects
// even though kysely's `Timestamp = string` type alias claims
// otherwise. Round-tripping a Date back into a kysely WHERE clause
// fails because `String(Date)` produces "Mon May 18 2026 ... GMT-0500
// (Central Daylight Time)" which Postgres rejects with
// `time zone "gmt-0500" not recognized`. This helper normalises to
// an ISO-8601 string (or null) regardless of which form arrives.
export function isoOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

// ── League-window-aware variants ─────────────────────────────
// When a league sets start_date/end_date, callers want the same
// queries restricted to tournaments inside that window. Each
// helper accepts nullable bounds — null = unbounded on that side
// (matches the schema: existing/legacy leagues with NULL dates
// keep behaving as "all tournaments").

export async function getActiveTournamentInRange(
  start: string | null,
  end:   string | null,
) {
  // Same time-based logic as getActiveTournament, layered with the
  // league window. Returns null when no in-range tournament is live.
  const now       = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  let q = db.selectFrom('tournaments').selectAll()
    .where('start_date', '<=', now.toISOString())
    .where('end_date',   '>=', oneDayAgo.toISOString())
    .where('status', '!=', 'complete');
  if (start) q = q.where('start_date', '>=', start);
  if (end)   q = q.where('start_date', '<=', end);
  return await q.orderBy('start_date', 'asc').limit(1).executeTakeFirst() ?? null;
}

export async function getUpcomingTournamentsInRange(
  start: string | null,
  end:   string | null,
  limit = 5,
) {
  let q = db.selectFrom('tournaments').selectAll()
    .where('status', '=', 'upcoming');
  if (start) q = q.where('start_date', '>=', start);
  if (end)   q = q.where('start_date', '<=', end);
  return await q.orderBy('start_date', 'asc').limit(limit).execute();
}

/**
 * Completed tournaments inside the league window — drives the money
 * card on the sidebar + the history page's per-tournament breakdown.
 * Ordered newest first so the history page reads chronologically
 * top-to-bottom.
 */
export async function getCompletedTournamentsInRange(
  start: string | null,
  end:   string | null,
) {
  let q = db.selectFrom('tournaments').selectAll()
    .where('status', '=', 'complete');
  if (start) q = q.where('start_date', '>=', start);
  if (end)   q = q.where('start_date', '<=', end);
  return await q.orderBy('start_date', 'desc').execute();
}

/**
 * Lightweight fantasy_results pull for the money math — only the
 * columns we need (user_id + rank + tournament_id) for every
 * fantasy_results row in this league across the given tournament
 * IDs. Returns an empty array when `tournamentIds` is empty so the
 * caller doesn't need to gate.
 */
export async function getFantasyResultsForTournaments(
  leagueId: string,
  tournamentIds: string[],
) {
  if (tournamentIds.length === 0) return [];
  return await db.selectFrom('fantasy_results')
    .select(['user_id', 'rank', 'tournament_id'])
    .where('league_id', '=', leagueId)
    .where('tournament_id', 'in', tournamentIds)
    .execute();
}

// ── picks (with embedded golfer rows for all 4 slots) ────────

export async function getPicksForTournament(leagueId: string, tournamentId: string) {
  return await db.selectFrom('picks')
    .selectAll('picks')
    .select(eb => [
      jsonObjectFrom(
        eb.selectFrom('golfers')
          .selectAll('golfers')
          .whereRef('golfers.id', '=', 'picks.golfer_1_id'),
      ).as('golfer_1'),
      jsonObjectFrom(
        eb.selectFrom('golfers')
          .selectAll('golfers')
          .whereRef('golfers.id', '=', 'picks.golfer_2_id'),
      ).as('golfer_2'),
      jsonObjectFrom(
        eb.selectFrom('golfers')
          .selectAll('golfers')
          .whereRef('golfers.id', '=', 'picks.golfer_3_id'),
      ).as('golfer_3'),
      jsonObjectFrom(
        eb.selectFrom('golfers')
          .selectAll('golfers')
          .whereRef('golfers.id', '=', 'picks.golfer_4_id'),
      ).as('golfer_4'),
    ])
    .where('league_id', '=', leagueId)
    .where('tournament_id', '=', tournamentId)
    .execute();
}

// ── scores ───────────────────────────────────────────────────

export async function getScoresForTournament(tournamentId: string) {
  return await db.selectFrom('scores')
    .selectAll()
    .where('tournament_id', '=', tournamentId)
    .execute();
}

// ── tournament leaderboard ───────────────────────────────────
// Top `limit` players in the actual PGA event for a tournament,
// ordered by score_to_par ascending (lower = better in golf), with
// golfer name + OWGR rank joined in. Includes everyone in the field,
// not just golfers somebody picked. Used by the league dashboard's
// sidebar leaderboard card.
//
// `position` ties (T15) come straight from ESPN's `scores.position`
// string; the caller renders it verbatim. Golfers without a recorded
// `score_to_par` (haven't teed off yet) are excluded so the table
// stays a meaningful "currently best in the field" view.
export async function getTournamentLeaderboard(
  tournamentId: string,
  limit = 25,
) {
  return await db.selectFrom('scores')
    .innerJoin('golfers', 'golfers.id', 'scores.golfer_id')
    .select([
      'scores.golfer_id',
      'scores.score_to_par',
      'scores.position',
      'scores.status',
      'scores.total_strokes',
      'scores.round_1',
      'scores.round_2',
      'scores.round_3',
      'scores.round_4',
      'golfers.name as golfer_name',
      'golfers.owgr_rank',
      'golfers.country',
    ])
    .where('scores.tournament_id', '=', tournamentId)
    .where('scores.score_to_par', 'is not', null)
    .orderBy('scores.score_to_par', 'asc')
    .limit(limit)
    .execute();
}

// ── fantasy_results (with embedded profile) ──────────────────

export async function getFantasyLeaderboard(leagueId: string, tournamentId: string) {
  return await db.selectFrom('fantasy_results')
    .selectAll('fantasy_results')
    .select(eb => jsonObjectFrom(
      eb.selectFrom('profiles')
        .selectAll('profiles')
        .whereRef('profiles.id', '=', 'fantasy_results.user_id'),
    ).as('profile'))
    .where('league_id', '=', leagueId)
    .where('tournament_id', '=', tournamentId)
    .orderBy('rank', 'asc')
    .execute();
}

// ── season_standings (with embedded profile) ─────────────────

export async function getSeasonStandings(leagueId: string, season: number) {
  return await db.selectFrom('season_standings')
    .selectAll('season_standings')
    .select(eb => jsonObjectFrom(
      eb.selectFrom('profiles')
        .selectAll('profiles')
        .whereRef('profiles.id', '=', 'season_standings.user_id'),
    ).as('profile'))
    .where('league_id', '=', leagueId)
    .where('season', '=', season)
    .orderBy('rank', 'asc')
    .execute();
}

// ── invite-code helper (was in lib/supabase.ts) ──────────────

export function generateInviteCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}
