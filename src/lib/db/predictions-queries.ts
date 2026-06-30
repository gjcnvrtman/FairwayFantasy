// ============================================================
// PREDICTIONS QUERIES — Kysely SELECTs + INSERTs that bridge DB
// rows to the pure scoring layer in src/lib/course-fit.ts and
// src/lib/lineup-optimizer.ts.
//
// Exposed as a `PredictionsQueries` interface + a factory
// `createProductionQueries(db)`. The orchestrator (src/lib/
// predictions-orchestrator.ts) accepts the interface so tests can
// inject mocks instead of hitting Postgres.
//
// Conversion notes:
//  * pg returns NUMERIC columns as strings; this module converts
//    them to numbers at the boundary so the scoring math doesn't
//    deal with mixed types.
//  * scores.status drives Finish.missedCut. scores.position is
//    parsed for the numeric finish position (e.g. "T4" -> 4).
// ============================================================

import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from './schema';
import type {
  CourseProfile, ScoringWeights, Finish,
  GolferStatRow, DatagolfPredsRow,
} from '@/lib/course-fit';

// ── Number coercion helpers ────────────────────────────────

function num(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Parse the ESPN-style position string ("T4", "1", "CUT", "WD") to
 *  a numeric finish position. 999 = missed-cut sentinel (matches
 *  course-fit.Finish convention). */
function parsePosition(pos: string | null): number {
  if (!pos) return 999;
  const cleaned = pos.replace(/^T/i, '').trim().toUpperCase();
  if (cleaned === 'CUT' || cleaned === 'MC' || cleaned === 'WD' || cleaned === 'DQ') {
    return 999;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : 999;
}

// ── Output types for the bulk loader ───────────────────────

export interface TournamentFieldRow {
  golferId: string;
  owgrRank: number | null;
}

export interface RunPersistInput {
  tournamentId: string;
  weightConfigId: string;
  statAsOfDate: string | null;
  fieldSize: number;
  golfersWithCompleteStats: number;
  golfersWithMissingStats: number;
  missingInputs: Record<string, number>;     // {"sg_app": 12, "course_history": 30}
  triggeredBy: string | null;
}

export interface GolferPredictionPersistRow {
  runId: string;
  golferId: string;
  isTopTier: boolean;
  courseFit: number;
  recentForm: number;
  longTerm: number;
  courseHistory: number;
  cutProbability: number;
  upside: number;
  composite: number;
  projectedStrokesToPar: number;
  projectedCutMadeProb: number;
  explanation: string;
}

export interface FoursomePersistRow {
  runId: string;
  rank: number;
  topTier1Id: string;
  topTier2Id: string;
  darkHorse1Id: string;
  darkHorse2Id: string;
  foursomeHash: string;
  projectedFantasyScore: number;
  confidenceScore: number;
  riskLevel: 'conservative' | 'balanced' | 'aggressive';
  estimatedOwnershipPct: number | null;
  keyStrengths: string[];
  keyConcerns: string[];
  foursomeExplanation: string;
}

// ── The DI interface ───────────────────────────────────────

export interface PredictionsQueries {
  loadActiveWeightConfig(): Promise<{ id: string; weights: ScoringWeights } | null>;
  loadWeightConfig(id: string): Promise<{ id: string; weights: ScoringWeights } | null>;
  loadCourseProfile(tournamentId: string): Promise<{ id: string; profile: CourseProfile; comparableIds: string[] } | null>;
  loadTournamentField(tournamentId: string): Promise<TournamentFieldRow[]>;
  loadStatsSnapshot(golferId: string, asOfDate: string): Promise<GolferStatRow | null>;
  /** Latest as_of_date across the snapshots table; used by the
   *  orchestrator to default to "the most recent data we have"
   *  rather than today's date (which can be earlier than a
   *  freshly-uploaded Wednesday snapshot). NULL if no snapshots. */
  loadLatestStatSnapshotDate(): Promise<string | null>;
  loadDatagolfPreds(tournamentId: string, golferId: string): Promise<DatagolfPredsRow | null>;
  /**
   * @param asOfDate Optional cutoff. When supplied, only events with
   *   `end_date < asOfDate` are considered — used by the backtest
   *   orchestrator to prevent future-data leakage.
   */
  loadRecentFinishes(golferId: string, limit?: number, asOfDate?: string): Promise<Finish[]>;
  loadCourseHistory(golferId: string, courseProfileId: string, limit?: number, asOfDate?: string): Promise<Finish[]>;
  loadComparableHistory(golferId: string, comparableProfileIds: string[], limit?: number, asOfDate?: string): Promise<Finish[]>;
  loadOwnership(tournamentId: string): Promise<Map<string, number>>;
  insertRun(input: RunPersistInput): Promise<string>;
  insertGolferPredictions(rows: GolferPredictionPersistRow[]): Promise<void>;
  insertFoursomes(rows: FoursomePersistRow[]): Promise<void>;
  markRunComplete(runId: string): Promise<void>;
  markRunFailed(runId: string, error: string): Promise<void>;

  // ── Backtest paths ───────────────────────────────────
  loadTournamentMeta(id: string): Promise<{ pickDeadline: string | null; endDate: string } | null>;
  loadActualResults(tournamentId: string): Promise<BacktestActualRow[]>;
  loadLeagueOutcomes(tournamentId: string): Promise<BacktestLeagueOutcomeRow[]>;
  insertBacktestRun(input: BacktestRunPersistInput): Promise<string>;
  insertBacktestResult(input: BacktestResultPersistInput): Promise<void>;
  markBacktestComplete(id: string, agg: BacktestAggregatePersist): Promise<void>;
  markBacktestFailed(id: string, error: string): Promise<void>;
}

export interface BacktestActualRow {
  golferId: string;
  owgrRank: number | null;
  position: number;
  missedCut: boolean;
  fantasyScore: number | null;
}

export interface BacktestLeagueOutcomeRow {
  leagueId: string;
  userId: string;
  golferIds: [string, string, string, string];
  totalScore: number;
}

export interface BacktestRunPersistInput {
  weightConfigId: string;
  tournamentIds: string[];
  triggeredBy: string | null;
}

export interface BacktestResultPersistInput {
  backtestRunId: string;
  tournamentId: string;
  predictionRunId: string | null;
  projectedScore: number;
  actualScore: number;
  bestRecommendedRankInLeague: number | null;
  beatLeagueAverage: boolean | null;
  beatLeagueWinner: boolean | null;
  avgFinishRecommended: number;
  madeCutPct: number;
  top10Pct: number;
  top20Pct: number;
  totalFantasyPoints: number;
  regretScore: number;
  sleeperAccuracy: number;
  details: unknown;
}

export interface BacktestAggregatePersist {
  eventsTested: number;
  eventsWithCompleteData: number;
  avgProjectedVsActual: number;
  avgBestFoursomeRank: number | null;
  pctBeatLeagueAverage: number | null;
  pctBeatLeagueWinner: number | null;
  avgSleeperAccuracy: number;
}

// ── Production factory ─────────────────────────────────────

export function createProductionQueries(db: Kysely<Database>): PredictionsQueries {
  return {
    async loadActiveWeightConfig() {
      const row = await db.selectFrom('model_weight_configs')
        .selectAll()
        .where('is_active', '=', true)
        .executeTakeFirst();
      if (!row) return null;
      return {
        id: row.id,
        weights: {
          courseFit:      Number(row.course_fit_weight),
          recentForm:     Number(row.recent_form_weight),
          longTerm:       Number(row.long_term_weight),
          courseHistory:  Number(row.course_history_weight),
          cutProbability: Number(row.cut_probability_weight),
          upside:         Number(row.upside_weight),
        },
      };
    },

    async loadWeightConfig(id) {
      const row = await db.selectFrom('model_weight_configs')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) return null;
      return {
        id: row.id,
        weights: {
          courseFit:      Number(row.course_fit_weight),
          recentForm:     Number(row.recent_form_weight),
          longTerm:       Number(row.long_term_weight),
          courseHistory:  Number(row.course_history_weight),
          cutProbability: Number(row.cut_probability_weight),
          upside:         Number(row.upside_weight),
        },
      };
    },

    async loadCourseProfile(tournamentId) {
      const t = await db.selectFrom('tournaments')
        .select(['course_profile_id'])
        .where('id', '=', tournamentId)
        .executeTakeFirst();
      if (!t?.course_profile_id) return null;
      const cp = await db.selectFrom('course_profiles')
        .selectAll()
        .where('id', '=', t.course_profile_id)
        .executeTakeFirst();
      if (!cp) return null;
      return {
        id: cp.id,
        profile: {
          scoringDifficulty:           num(cp.scoring_difficulty),
          drivingDistanceImportance:   num(cp.driving_distance_importance),
          drivingAccuracyImportance:   num(cp.driving_accuracy_importance),
          approachImportance:          num(cp.approach_importance),
          aroundGreenImportance:       num(cp.around_green_importance),
          puttingImportance:           num(cp.putting_importance),
        },
        comparableIds: cp.comparable_course_ids ?? [],
      };
    },

    async loadTournamentField(tournamentId) {
      // The field for an UPCOMING event comes from Datagolf preds
      // (which is the only structured source we have for who's in
      // this week's field). For events with scores already (in-play
      // or complete), use the scores table — it's authoritative.
      //
      // Try scores first; fall back to datagolf preds if empty.
      const fromScores = await db.selectFrom('scores')
        .innerJoin('golfers', 'golfers.id', 'scores.golfer_id')
        .select(['golfers.id as golferId', 'golfers.owgr_rank as owgrRank'])
        .where('scores.tournament_id', '=', tournamentId)
        .execute();
      if (fromScores.length > 0) {
        return fromScores.map(r => ({ golferId: r.golferId, owgrRank: r.owgrRank }));
      }
      const fromDg = await db.selectFrom('datagolf_tournament_predictions')
        .innerJoin('golfers', 'golfers.id', 'datagolf_tournament_predictions.golfer_id')
        .select(['golfers.id as golferId', 'golfers.owgr_rank as owgrRank'])
        .where('datagolf_tournament_predictions.tournament_id', '=', tournamentId)
        .where('datagolf_tournament_predictions.golfer_id', 'is not', null)
        .execute();
      return fromDg.map(r => ({ golferId: r.golferId, owgrRank: r.owgrRank }));
    },

    async loadLatestStatSnapshotDate() {
      const row = await db.selectFrom('golfer_stat_snapshots')
        .select(eb => eb.fn.max<string>('as_of_date').as('max_date'))
        .executeTakeFirst();
      return row?.max_date ?? null;
    },

    async loadStatsSnapshot(golferId, asOfDate) {
      const row = await db.selectFrom('golfer_stat_snapshots')
        .selectAll()
        .where('golfer_id', '=', golferId)
        .where('as_of_date', '<=', asOfDate)
        .orderBy('as_of_date', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (!row) return null;
      return {
        sg_total:             num(row.sg_total),
        sg_ott:               num(row.sg_ott),
        sg_app:               num(row.sg_app),
        sg_arg:               num(row.sg_arg),
        sg_putt:              num(row.sg_putt),
        driving_distance:     num(row.driving_distance),
        driving_accuracy_pct: num(row.driving_accuracy_pct),
        gir_pct:              num(row.gir_pct),
        scoring_avg:          num(row.scoring_avg),
        birdie_avg:           num(row.birdie_avg),
        bogey_avg:            num(row.bogey_avg),
        made_cut_pct:         num(row.made_cut_pct),
      };
    },

    async loadDatagolfPreds(tournamentId, golferId) {
      const row = await db.selectFrom('datagolf_tournament_predictions')
        .selectAll()
        .where('tournament_id', '=', tournamentId)
        .where('golfer_id', '=', golferId)
        .executeTakeFirst();
      if (!row) return null;
      return {
        win_prob:      num(row.win_prob),
        top_5_prob:    num(row.top_5_prob),
        top_10_prob:   num(row.top_10_prob),
        top_20_prob:   num(row.top_20_prob),
        make_cut_prob: num(row.make_cut_prob),
      };
    },

    async loadRecentFinishes(golferId, limit = 6, asOfDate) {
      let q = db.selectFrom('scores')
        .innerJoin('tournaments', 'tournaments.id', 'scores.tournament_id')
        .select([
          'scores.position as position',
          'scores.status as status',
          'tournaments.end_date as endDate',
        ])
        .where('scores.golfer_id', '=', golferId)
        .where(eb => eb.or([
          eb('scores.status', '=', 'complete'),
          eb('scores.status', '=', 'missed_cut'),
          eb('scores.status', '=', 'withdrawn'),
          eb('scores.status', '=', 'disqualified'),
        ]))
        .orderBy('tournaments.end_date', 'desc')
        .limit(limit);
      if (asOfDate) q = q.where('tournaments.end_date', '<', asOfDate);
      const rows = await q.execute();
      return rows.map(r => ({
        position: parsePosition(r.position),
        missedCut: r.status === 'missed_cut' || r.status === 'withdrawn' || r.status === 'disqualified',
        eventDate: typeof r.endDate === 'string' ? r.endDate : new Date(r.endDate as unknown as number).toISOString(),
      }));
    },

    async loadCourseHistory(golferId, courseProfileId, limit = 5, asOfDate) {
      // Tournaments at this course = tournaments.course_profile_id matches.
      let q = db.selectFrom('scores')
        .innerJoin('tournaments', 'tournaments.id', 'scores.tournament_id')
        .select([
          'scores.position as position',
          'scores.status as status',
          'tournaments.end_date as endDate',
        ])
        .where('scores.golfer_id', '=', golferId)
        .where('tournaments.course_profile_id', '=', courseProfileId)
        .where(eb => eb.or([
          eb('scores.status', '=', 'complete'),
          eb('scores.status', '=', 'missed_cut'),
          eb('scores.status', '=', 'withdrawn'),
          eb('scores.status', '=', 'disqualified'),
        ]))
        .orderBy('tournaments.end_date', 'desc')
        .limit(limit);
      if (asOfDate) q = q.where('tournaments.end_date', '<', asOfDate);
      const rows = await q.execute();
      return rows.map(r => ({
        position: parsePosition(r.position),
        missedCut: r.status === 'missed_cut' || r.status === 'withdrawn' || r.status === 'disqualified',
        eventDate: typeof r.endDate === 'string' ? r.endDate : new Date(r.endDate as unknown as number).toISOString(),
      }));
    },

    async loadComparableHistory(golferId, comparableProfileIds, limit = 5, asOfDate) {
      if (comparableProfileIds.length === 0) return [];
      let q = db.selectFrom('scores')
        .innerJoin('tournaments', 'tournaments.id', 'scores.tournament_id')
        .select([
          'scores.position as position',
          'scores.status as status',
          'tournaments.end_date as endDate',
        ])
        .where('scores.golfer_id', '=', golferId)
        .where('tournaments.course_profile_id', 'in', comparableProfileIds)
        .where(eb => eb.or([
          eb('scores.status', '=', 'complete'),
          eb('scores.status', '=', 'missed_cut'),
          eb('scores.status', '=', 'withdrawn'),
          eb('scores.status', '=', 'disqualified'),
        ]))
        .orderBy('tournaments.end_date', 'desc')
        .limit(limit);
      if (asOfDate) q = q.where('tournaments.end_date', '<', asOfDate);
      const rows = await q.execute();
      return rows.map(r => ({
        position: parsePosition(r.position),
        missedCut: r.status === 'missed_cut' || r.status === 'withdrawn' || r.status === 'disqualified',
        eventDate: typeof r.endDate === 'string' ? r.endDate : new Date(r.endDate as unknown as number).toISOString(),
      }));
    },

    async loadOwnership(tournamentId) {
      // For every golfer slot across all picks for this tournament,
      // count distinct picks that include that golfer; divide by
      // total picks to get ownership 0..1.
      const totalRow = await db.selectFrom('picks')
        .select(eb => eb.fn.countAll<number>().as('n'))
        .where('tournament_id', '=', tournamentId)
        .executeTakeFirst();
      const totalPicks = Number(totalRow?.n ?? 0);
      const out = new Map<string, number>();
      if (totalPicks === 0) return out;

      // Union the 4 slots into a single per-golfer count via SQL.
      const counts = await sql<{ golfer_id: string; cnt: string }>`
        SELECT golfer_id, COUNT(*) AS cnt FROM (
          SELECT golfer_1_id AS golfer_id FROM picks WHERE tournament_id = ${tournamentId}
          UNION ALL
          SELECT golfer_2_id FROM picks WHERE tournament_id = ${tournamentId}
          UNION ALL
          SELECT golfer_3_id FROM picks WHERE tournament_id = ${tournamentId}
          UNION ALL
          SELECT golfer_4_id FROM picks WHERE tournament_id = ${tournamentId}
        ) s
        WHERE golfer_id IS NOT NULL
        GROUP BY golfer_id
      `.execute(db);
      for (const r of counts.rows) {
        out.set(r.golfer_id, Number(r.cnt) / totalPicks);
      }
      return out;
    },

    async insertRun(input) {
      const row = await db.insertInto('tournament_prediction_runs')
        .values({
          tournament_id:                  input.tournamentId,
          weight_config_id:               input.weightConfigId,
          stat_as_of_date:                input.statAsOfDate,
          field_size:                     input.fieldSize,
          golfers_with_complete_stats:    input.golfersWithCompleteStats,
          golfers_with_missing_stats:     input.golfersWithMissingStats,
          missing_inputs:                 input.missingInputs as unknown,
          status:                         'running',
          triggered_by:                   input.triggeredBy,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },

    async insertGolferPredictions(rows) {
      if (rows.length === 0) return;
      await db.insertInto('golfer_predictions')
        .values(rows.map(r => ({
          run_id:                     r.runId,
          golfer_id:                  r.golferId,
          is_top_tier:                r.isTopTier,
          course_fit_score:           r.courseFit.toString(),
          recent_form_score:          r.recentForm.toString(),
          long_term_score:            r.longTerm.toString(),
          course_history_score:       r.courseHistory.toString(),
          cut_probability_score:      r.cutProbability.toString(),
          upside_score:               r.upside.toString(),
          composite_score:            r.composite.toString(),
          projected_strokes_to_par:   r.projectedStrokesToPar.toString(),
          projected_cut_made_prob:    r.projectedCutMadeProb.toString(),
          explanation:                r.explanation,
        })))
        .execute();
    },

    async insertFoursomes(rows) {
      if (rows.length === 0) return;
      await db.insertInto('foursome_recommendations')
        .values(rows.map(r => ({
          run_id:                   r.runId,
          rank:                     r.rank,
          top_tier_1_golfer_id:     r.topTier1Id,
          top_tier_2_golfer_id:     r.topTier2Id,
          dark_horse_1_golfer_id:   r.darkHorse1Id,
          dark_horse_2_golfer_id:   r.darkHorse2Id,
          foursome_hash:            r.foursomeHash,
          projected_fantasy_score:  r.projectedFantasyScore.toString(),
          confidence_score:         r.confidenceScore.toString(),
          risk_level:               r.riskLevel,
          estimated_ownership_pct:  r.estimatedOwnershipPct == null
                                      ? null
                                      : r.estimatedOwnershipPct.toString(),
          key_strengths:            r.keyStrengths,
          key_concerns:             r.keyConcerns,
          foursome_explanation:     r.foursomeExplanation,
        })))
        .execute();
    },

    async markRunComplete(runId) {
      await db.updateTable('tournament_prediction_runs')
        .set({ status: 'complete', completed_at: new Date().toISOString() })
        .where('id', '=', runId)
        .execute();
    },

    async markRunFailed(runId, error) {
      await db.updateTable('tournament_prediction_runs')
        .set({ status: 'failed', error, completed_at: new Date().toISOString() })
        .where('id', '=', runId)
        .execute();
    },

    // ── Backtest paths ───────────────────────────────────

    async loadTournamentMeta(id) {
      const row = await db.selectFrom('tournaments')
        .select(['pick_deadline', 'end_date'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) return null;
      return { pickDeadline: row.pick_deadline, endDate: row.end_date };
    },

    async loadActualResults(tournamentId) {
      const rows = await db.selectFrom('scores')
        .innerJoin('golfers', 'golfers.id', 'scores.golfer_id')
        .select([
          'scores.golfer_id as golferId',
          'golfers.owgr_rank as owgrRank',
          'scores.position as position',
          'scores.status as status',
          'scores.fantasy_score as fantasyScore',
        ])
        .where('scores.tournament_id', '=', tournamentId)
        .execute();
      return rows.map(r => ({
        golferId: r.golferId,
        owgrRank: r.owgrRank,
        position: parsePosition(r.position),
        missedCut: r.status === 'missed_cut' || r.status === 'withdrawn' || r.status === 'disqualified',
        fantasyScore: r.fantasyScore,
      }));
    },

    async loadLeagueOutcomes(tournamentId) {
      // fantasy_results carries the final realized league total per
      // member; picks carries which 4 golfers they submitted.
      const rows = await db.selectFrom('fantasy_results')
        .innerJoin('picks',
          jb => jb.onRef('picks.league_id', '=', 'fantasy_results.league_id')
            .onRef('picks.user_id', '=', 'fantasy_results.user_id')
            .onRef('picks.tournament_id', '=', 'fantasy_results.tournament_id'))
        .select([
          'fantasy_results.league_id as leagueId',
          'fantasy_results.user_id as userId',
          'picks.golfer_1_id as g1',
          'picks.golfer_2_id as g2',
          'picks.golfer_3_id as g3',
          'picks.golfer_4_id as g4',
          'fantasy_results.total_score as totalScore',
        ])
        .where('fantasy_results.tournament_id', '=', tournamentId)
        .execute();
      return rows
        .filter(r => r.g1 && r.g2 && r.g3 && r.g4 && r.totalScore != null)
        .map(r => ({
          leagueId: r.leagueId,
          userId: r.userId,
          golferIds: [r.g1!, r.g2!, r.g3!, r.g4!] as [string, string, string, string],
          totalScore: r.totalScore!,
        }));
    },

    async insertBacktestRun(input) {
      const row = await db.insertInto('backtest_runs')
        .values({
          weight_config_id: input.weightConfigId,
          tournament_ids:   input.tournamentIds,
          status:           'running',
          triggered_by:     input.triggeredBy,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },

    async insertBacktestResult(input) {
      await db.insertInto('backtest_results')
        .values({
          backtest_run_id:                  input.backtestRunId,
          tournament_id:                    input.tournamentId,
          prediction_run_id:                input.predictionRunId,
          projected_score:                  input.projectedScore.toString(),
          actual_score:                     input.actualScore.toString(),
          best_recommended_rank_in_league:  input.bestRecommendedRankInLeague,
          beat_league_average:              input.beatLeagueAverage,
          beat_league_winner:               input.beatLeagueWinner,
          avg_finish_recommended:           input.avgFinishRecommended.toString(),
          made_cut_pct:                     input.madeCutPct.toString(),
          top_10_pct:                       input.top10Pct.toString(),
          top_20_pct:                       input.top20Pct.toString(),
          total_fantasy_points:             input.totalFantasyPoints.toString(),
          regret_score:                     input.regretScore.toString(),
          sleeper_accuracy:                 input.sleeperAccuracy.toString(),
          details:                          input.details as unknown,
        })
        .execute();
    },

    async markBacktestComplete(id, agg) {
      await db.updateTable('backtest_runs')
        .set({
          status:                       'complete',
          events_tested:                agg.eventsTested,
          events_with_complete_data:    agg.eventsWithCompleteData,
          avg_projected_vs_actual:      agg.avgProjectedVsActual.toString(),
          avg_best_foursome_rank:       agg.avgBestFoursomeRank == null ? null : agg.avgBestFoursomeRank.toString(),
          pct_beat_league_average:      agg.pctBeatLeagueAverage  == null ? null : agg.pctBeatLeagueAverage.toString(),
          pct_beat_league_winner:       agg.pctBeatLeagueWinner   == null ? null : agg.pctBeatLeagueWinner.toString(),
          avg_sleeper_accuracy:         agg.avgSleeperAccuracy.toString(),
          completed_at:                 new Date().toISOString(),
        })
        .where('id', '=', id)
        .execute();
    },

    async markBacktestFailed(id, error) {
      await db.updateTable('backtest_runs')
        .set({ status: 'failed', notes: error, completed_at: new Date().toISOString() })
        .where('id', '=', id)
        .execute();
    },
  };
}
