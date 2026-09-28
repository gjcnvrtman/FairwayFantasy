// ============================================================
// PREDICTIONS VIEWS — read queries shared by the /predictions pages,
// the /api/predictions routes and the predictions email, so each
// question is answered one way in one place (was copy-pasted per
// caller; see TODO "Predictions duplicate-query audit", 2026-09-28).
//
// The predictor's own DB access stays behind the PredictionsQueries
// interface in predictions-queries.ts (injectable for tests); these are
// plain display reads.
// ============================================================

import { sql } from 'kysely';
import { db } from './index';

// ── Tournaments ──────────────────────────────────────────────

/**
 * The tournament the predictor is working on: the next one to start,
 * or — once it has started — the one in play. "In play" is date-based,
 * the same test runScoreSync uses (started, ended less than a day ago,
 * not complete); stored `status='active'` can lag. Hidden events and
 * non-PGA types are excluded.
 */
export async function loadCurrentOrNextTournament() {
  const now = new Date();
  const cols = ['id', 'name', 'start_date', 'end_date', 'status',
                'course_name', 'course_profile_id'] as const;
  const next = await db.selectFrom('tournaments')
    .select(cols)
    .where('hidden', '=', false)
    .where('type', 'in', ['regular', 'major'])
    .where('start_date', '>=', now.toISOString())
    .orderBy('start_date', 'asc')
    .limit(1)
    .executeTakeFirst();
  if (next) return next;
  return await db.selectFrom('tournaments')
    .select(cols)
    .where('hidden', '=', false)
    .where('type', 'in', ['regular', 'major'])
    .where('start_date', '<=', now.toISOString())
    .where('end_date', '>=', new Date(now.getTime() - 24 * 3600_000).toISOString())
    .where('status', '!=', 'complete')
    .orderBy('start_date', 'desc')
    .limit(1)
    .executeTakeFirst() ?? null;
}

/** Tournaments a course profile can be linked to: PGA events in
 *  [from, now + 1 year], hidden events excluded. */
export async function listLinkableTournaments(from: Date) {
  const yearFromNow = new Date(Date.now() + 365 * 86400_000).toISOString();
  return await db.selectFrom('tournaments')
    .select(['id', 'name', 'start_date'])
    .where('hidden', '=', false)
    .where('type', 'in', ['regular', 'major'])
    .where('start_date', '>=', from.toISOString())
    .where('start_date', '<=', yearFromNow)
    .orderBy('start_date', 'asc')
    .execute();
}

/** Backtest targets: scored (cut made / complete), course profile
 *  linked, not hidden. */
export async function listBacktestableTournaments() {
  return await db.selectFrom('tournaments')
    .innerJoin('scores', 'scores.tournament_id', 'tournaments.id')
    .select([
      'tournaments.id as id',
      'tournaments.name as name',
      'tournaments.start_date as start_date',
      eb => eb.fn.count<number>('scores.id').as('scores_count'),
    ])
    .where('tournaments.status', 'in', ['complete', 'cut_made'])
    .where('tournaments.course_profile_id', 'is not', null)
    .where('tournaments.hidden', '=', false)
    .groupBy(['tournaments.id', 'tournaments.name', 'tournaments.start_date'])
    .orderBy('tournaments.start_date', 'desc')
    .execute();
}

// ── Prediction runs ──────────────────────────────────────────

/** A run's recommended teams (foursomes, then six-man teams; rank
 *  order within each) plus golfer id → name for every golfer on them. */
export async function loadRunTeams(runId: string) {
  const teams = await db.selectFrom('foursome_recommendations')
    .selectAll()
    .where('run_id', '=', runId)
    .orderBy('team_size', 'asc')
    .orderBy('rank', 'asc')
    .execute();
  const ids = new Set<string>();
  for (const f of teams) {
    for (const id of [f.top_tier_1_golfer_id, f.top_tier_2_golfer_id, f.top_tier_3_golfer_id,
                      f.dark_horse_1_golfer_id, f.dark_horse_2_golfer_id, f.dark_horse_3_golfer_id]) {
      if (id) ids.add(id);
    }
  }
  const names = ids.size === 0 ? [] : await db.selectFrom('golfers')
    .select(['id', 'name'])
    .where('id', 'in', [...ids])
    .execute();
  return { teams, nameById: new Map(names.map(n => [n.id, n.name])) };
}

// ── Backtests ────────────────────────────────────────────────

export async function listBacktestRuns(limit = 50) {
  return await db.selectFrom('backtest_runs')
    .selectAll()
    .orderBy('started_at', 'desc')
    .limit(limit)
    .execute();
}

/** One backtest run + its per-event results (oldest event first). */
export async function loadBacktestDetail(id: string) {
  const run = await db.selectFrom('backtest_runs')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!run) return null;
  const results = await db.selectFrom('backtest_results')
    .innerJoin('tournaments', 'tournaments.id', 'backtest_results.tournament_id')
    .select([
      'backtest_results.id as id',
      'backtest_results.tournament_id as tournament_id',
      'tournaments.name as tournament_name',
      'tournaments.start_date as start_date',
      'backtest_results.prediction_run_id as prediction_run_id',
      'backtest_results.projected_score as projected_score',
      'backtest_results.actual_score as actual_score',
      'backtest_results.best_recommended_rank_in_league as best_recommended_rank_in_league',
      'backtest_results.beat_league_average as beat_league_average',
      'backtest_results.beat_league_winner as beat_league_winner',
      'backtest_results.avg_finish_recommended as avg_finish_recommended',
      'backtest_results.made_cut_pct as made_cut_pct',
      'backtest_results.top_10_pct as top_10_pct',
      'backtest_results.top_20_pct as top_20_pct',
      'backtest_results.total_fantasy_points as total_fantasy_points',
      'backtest_results.regret_score as regret_score',
      'backtest_results.sleeper_accuracy as sleeper_accuracy',
      'backtest_results.details as details',
    ])
    .where('backtest_results.backtest_run_id', '=', id)
    .orderBy('tournaments.start_date', 'asc')
    .execute();
  return { run, results };
}

// ── Stat snapshots / weights ─────────────────────────────────

/** Uploaded stat snapshots grouped by as-of date (newest first). Counts
 *  come back as text from Postgres; callers convert if they need numbers. */
export async function loadSnapshotGroups(limit = 50) {
  const result = await sql<{
    as_of_date: string;
    total: string;
    matched: string;
    unmatched: string;
    last_uploaded_at: string;
  }>`
    SELECT
      as_of_date::text AS as_of_date,
      COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE golfer_id IS NOT NULL)::text AS matched,
      COUNT(*) FILTER (WHERE golfer_id IS NULL)::text AS unmatched,
      MAX(uploaded_at)::text AS last_uploaded_at
    FROM golfer_stat_snapshots
    GROUP BY as_of_date
    ORDER BY as_of_date DESC
    LIMIT ${limit}
  `.execute(db);
  return result.rows;
}

/** All weight configs, active first, then newest. */
export async function listWeightConfigs() {
  return await db.selectFrom('model_weight_configs')
    .selectAll()
    .orderBy('is_active', 'desc')
    .orderBy('created_at', 'desc')
    .execute();
}
