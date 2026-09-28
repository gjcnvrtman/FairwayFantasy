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
import { resolveTournamentBet, type PayoutStructure } from '@/lib/money';

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

// ── Per-league schedule (migration 022) ──────────────────────
// Pre-022 these helpers were "every global tournament whose
// start_date lies in the league's date window." Post-022 the
// source of truth is the league_tournaments join table — the
// window is only a legacy secondary filter (the backfill in
// migration 022 already respected it, so passing it here is
// mostly redundant but harmless). Callers that already compute
// (start, end) keep working unchanged; new callers can pass
// (null, null) and rely purely on the join.
//
// Every helper INNER JOINs league_tournaments so events the
// commissioner removed disappear from the schedule, picks page,
// history, stats, money math, everywhere. `tournaments.hidden`
// is filtered as belt-and-suspenders — a hidden row shouldn't
// be in league_tournaments to begin with (migration 022's
// backfill excludes them + the /api/admin/schedule add endpoint
// rejects them), but if one slips in the display still won't
// leak it.

export async function getActiveTournamentInRange(
  leagueId: string,
  start:    string | null,
  end:      string | null,
) {
  // Same time-based logic as getActiveTournament, layered with the
  // league window. Returns null when no in-range tournament is live.
  const now       = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  let q = db.selectFrom('tournaments')
    .innerJoin('league_tournaments', 'league_tournaments.tournament_id', 'tournaments.id')
    .selectAll('tournaments')
    .where('league_tournaments.league_id', '=', leagueId)
    .where('tournaments.hidden', '=', false)
    .where('start_date', '<=', now.toISOString())
    .where('end_date',   '>=', oneDayAgo.toISOString())
    .where('status', '!=', 'complete');
  if (start) q = q.where('start_date', '>=', start);
  if (end)   q = q.where('start_date', '<=', end);
  return await q.orderBy('start_date', 'asc').limit(1).executeTakeFirst() ?? null;
}

export async function getUpcomingTournamentsInRange(
  leagueId: string,
  start:    string | null,
  end:      string | null,
  limit = 5,
) {
  let q = db.selectFrom('tournaments')
    .innerJoin('league_tournaments', 'league_tournaments.tournament_id', 'tournaments.id')
    .selectAll('tournaments')
    .where('league_tournaments.league_id', '=', leagueId)
    .where('tournaments.hidden', '=', false)
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
  leagueId: string,
  start:    string | null,
  end:      string | null,
) {
  let q = db.selectFrom('tournaments')
    .innerJoin('league_tournaments', 'league_tournaments.tournament_id', 'tournaments.id')
    .selectAll('tournaments')
    .where('league_tournaments.league_id', '=', leagueId)
    .where('tournaments.hidden', '=', false)
    .where('status', '=', 'complete');
  if (start) q = q.where('start_date', '>=', start);
  if (end)   q = q.where('start_date', '<=', end);
  return await q.orderBy('start_date', 'desc').execute();
}

/**
 * Every tournament in the league's per-league schedule, regardless
 * of status. Drives the Schedule tab — needs upcoming + active +
 * cut_made + complete in one chronological list. Ordered ascending
 * so the page reads "what's next at the top, what already happened
 * at the bottom" (with current week's tournament in the middle if
 * there is one).
 */
export async function getAllTournamentsInRange(
  leagueId: string,
  start:    string | null,
  end:      string | null,
) {
  let q = db.selectFrom('tournaments')
    .innerJoin('league_tournaments', 'league_tournaments.tournament_id', 'tournaments.id')
    .selectAll('tournaments')
    .where('league_tournaments.league_id', '=', leagueId)
    .where('tournaments.hidden', '=', false);
  if (start) q = q.where('start_date', '>=', start);
  if (end)   q = q.where('start_date', '<=', end);
  return await q.orderBy('start_date', 'asc').execute();
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

// ── per-tournament bet overrides (migration 010) ─────────────

/**
 * Return a `Map<tournament_id, effective_bet_amount>` for every
 * tournament passed in, resolved by `resolveTournamentBet`:
 * per-tournament override > majors bet (majors only) > weekly bet.
 * Money-math callers use this map to fill the per-tournament
 * `betAmount` field on `computeLeagueMoney`'s tournaments input.
 */
export async function getEffectiveBetsForTournaments(
  leagueId: string,
  tournaments: Array<{ id: string; type: string }>,
  defaults: { weekly: number; major: number | null },
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (tournaments.length === 0) return out;
  const rows = await db.selectFrom('league_tournament_bets')
    .select(['tournament_id', 'bet_amount'])
    .where('league_id', '=', leagueId)
    .where('tournament_id', 'in', tournaments.map(t => t.id))
    .execute();
  const overrides = new Map(rows.map(r => [r.tournament_id, Number(r.bet_amount)]));
  for (const t of tournaments) {
    out.set(t.id, resolveTournamentBet({
      override: overrides.get(t.id),
      isMajor:  t.type === 'major',
      weekly:   defaults.weekly,
      major:    defaults.major,
    }));
  }
  return out;
}

/** League row → bet defaults for getEffectiveBetsForTournaments. */
export function betDefaultsFromLeague(league: {
  weekly_bet_amount: string | number | null;
  major_bet_amount:  string | number | null;
}): { weekly: number; major: number | null } {
  return {
    weekly: Number(league.weekly_bet_amount ?? 0),
    major:  league.major_bet_amount == null ? null : Number(league.major_bet_amount),
  };
}

// ── per-tournament payout snapshots (migration 024) ──────────


/**
 * Return a `Map<tournament_id, PayoutStructure>` for every tournament
 * in `tournamentIds`. Tournaments without a snapshot resolve to the
 * league-level default (typically the current `leagues.payout_pct_*`).
 *
 * Snapshots exist when a commissioner edited the league payout AFTER
 * the tournament's pick_deadline passed — see the "freeze rule" block
 * comment in migration 024. Missing snapshot means either (a) the
 * tournament is still pre-lock, or (b) no edit has happened yet, in
 * which case falling back to the current league default is the right
 * answer.
 */
export async function getEffectivePayoutsForTournaments(
  leagueId: string,
  tournamentIds: string[],
  leagueDefaultPayout: PayoutStructure,
): Promise<Map<string, PayoutStructure>> {
  const out = new Map<string, PayoutStructure>();
  for (const tid of tournamentIds) out.set(tid, leagueDefaultPayout);
  if (tournamentIds.length === 0) return out;
  const rows = await db.selectFrom('league_tournament_payouts')
    .select(['tournament_id', 'payout_pct_1', 'payout_pct_2', 'payout_pct_3'])
    .where('league_id', '=', leagueId)
    .where('tournament_id', 'in', tournamentIds)
    .execute();
  for (const r of rows) {
    out.set(r.tournament_id, {
      pct1: r.payout_pct_1,
      pct2: r.payout_pct_2,
      pct3: r.payout_pct_3,
    });
  }
  return out;
}

// ── per-pick WD replacements (migration 028) ─────────────────

/** pick_id → { slot → replacement golfer id } for the given picks. */
export async function loadReplacements(
  pickIds: string[],
): Promise<Map<string, Partial<Record<number, string>>>> {
  const out = new Map<string, Partial<Record<number, string>>>();
  if (pickIds.length === 0) return out;
  const rows = await db.selectFrom('pick_replacements')
    .select(['pick_id', 'slot', 'replacement_golfer_id'])
    .where('pick_id', 'in', pickIds)
    .execute();
  for (const r of rows) {
    const m = out.get(r.pick_id) ?? {};
    m[r.slot] = r.replacement_golfer_id;
    out.set(r.pick_id, m);
  }
  return out;
}

/** Attach `replacements` (slot → replacement golfer id) to each pick. */
export async function withReplacements<T extends { id: string }>(
  picks: T[],
): Promise<Array<T & { replacements: Partial<Record<number, string>> }>> {
  const map = await loadReplacements(picks.map(p => p.id));
  return picks.map(p => ({ ...p, replacements: map.get(p.id) ?? {} }));
}

// ── picks (with embedded golfer rows for every slot) ─────────
// golfer_5 / golfer_6 are null except on 6-man majors (migration 026).

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
      jsonObjectFrom(
        eb.selectFrom('golfers')
          .selectAll('golfers')
          .whereRef('golfers.id', '=', 'picks.golfer_5_id'),
      ).as('golfer_5'),
      jsonObjectFrom(
        eb.selectFrom('golfers')
          .selectAll('golfers')
          .whereRef('golfers.id', '=', 'picks.golfer_6_id'),
      ).as('golfer_6'),
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
      'scores.holes_played',
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

// ── invite-code helper (was in lib/supabase.ts) ──────────────

export function generateInviteCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}
