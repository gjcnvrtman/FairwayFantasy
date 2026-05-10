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
  return await db.selectFrom('tournaments')
    .selectAll()
    .where('status', 'in', ['active', 'cut_made'])
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
