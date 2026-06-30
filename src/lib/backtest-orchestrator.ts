// ============================================================
// BACKTEST ORCHESTRATOR
//
// Loops over a set of completed tournaments. For each:
//   1. Compute `asOfDate = pick_deadline - 1 day` so the predictor
//      only sees data that would have been available the night
//      before the event started.
//   2. Call runPredictions with that asOfDate — produces a
//      tournament_prediction_runs row + golfer_predictions +
//      foursome_recommendations rows tagged with the snapshot date.
//   3. Load the ACTUAL per-golfer scores and per-league outcomes.
//   4. computeBacktestMetrics over the recommendation vs actual.
//   5. Persist backtest_results row.
// After all tournaments: aggregate + markBacktestComplete.
//
// Pure failure of one event = mark THAT event as missing data in
// the per-event row (with details.error), continue to the next.
// Catastrophic failure = markBacktestFailed at the run level.
// ============================================================

import { runPredictions } from './predictions-orchestrator';
import {
  computeBacktestMetrics, aggregateBacktestMetrics,
  type ActualGolferResult, type LeagueMemberOutcome,
  type RecommendedFoursome, type BacktestEventMetrics,
  type BacktestAggregateMetrics,
} from './backtest';
import { computeTopTierIds } from './field-tiers';
import type { PredictionsQueries } from './db/predictions-queries';

export interface BacktestOrchestrateOptions {
  tournamentIds: string[];
  weightConfigId?: string;
  triggeredBy?: string | null;
}

export interface BacktestEventOutcome {
  tournamentId: string;
  predictionRunId: string | null;
  metrics: BacktestEventMetrics | null;
  error: string | null;
}

export interface BacktestOrchestrateResult {
  backtestRunId: string;
  events: BacktestEventOutcome[];
  aggregate: BacktestAggregateMetrics;
}

/** Subtract one day from an ISO date string, returning YYYY-MM-DD. */
function dayBefore(iso: string): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function runBacktest(
  opts: BacktestOrchestrateOptions,
  queries: PredictionsQueries,
): Promise<BacktestOrchestrateResult> {
  // Resolve weight config (active or specified-by-id).
  const weights = opts.weightConfigId
    ? await queries.loadWeightConfig(opts.weightConfigId)
    : await queries.loadActiveWeightConfig();
  if (!weights) {
    throw new Error('No active weight config available for backtest');
  }

  if (opts.tournamentIds.length === 0) {
    throw new Error('runBacktest requires at least one tournament id');
  }

  const backtestRunId = await queries.insertBacktestRun({
    weightConfigId: weights.id,
    tournamentIds:  opts.tournamentIds,
    triggeredBy:    opts.triggeredBy ?? null,
  });

  const events: BacktestEventOutcome[] = [];
  try {
    for (const tournamentId of opts.tournamentIds) {
      const outcome = await scoreOneEvent(
        tournamentId, weights.id, opts.triggeredBy ?? null,
        backtestRunId, queries,
      );
      events.push(outcome);

      if (outcome.metrics) {
        await queries.insertBacktestResult({
          backtestRunId,
          tournamentId,
          predictionRunId: outcome.predictionRunId,
          projectedScore:               outcome.metrics.projectedScore,
          actualScore:                  outcome.metrics.actualScore,
          bestRecommendedRankInLeague:  outcome.metrics.bestRecommendedRankInLeague,
          beatLeagueAverage:            outcome.metrics.beatLeagueAverage,
          beatLeagueWinner:             outcome.metrics.beatLeagueWinner,
          avgFinishRecommended:         outcome.metrics.avgFinishRecommended,
          madeCutPct:                   outcome.metrics.madeCutPct,
          top10Pct:                     outcome.metrics.top10Pct,
          top20Pct:                     outcome.metrics.top20Pct,
          totalFantasyPoints:           outcome.metrics.totalFantasyPoints,
          regretScore:                  outcome.metrics.regretScore,
          sleeperAccuracy:              outcome.metrics.sleeperAccuracy,
          details:                      { error: outcome.error },
        });
      }
    }

    const aggregate = aggregateBacktestMetrics({
      perEvent: events.map(e => e.metrics).filter(Boolean) as BacktestEventMetrics[],
    });
    await queries.markBacktestComplete(backtestRunId, aggregate);
    return { backtestRunId, events, aggregate };
  } catch (err) {
    await queries.markBacktestFailed(
      backtestRunId,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }
}

/** Run prediction + score one event. Catches per-event errors and
 *  returns a structured failure so the loop survives. */
async function scoreOneEvent(
  tournamentId: string,
  weightConfigId: string,
  triggeredBy: string | null,
  _backtestRunId: string,
  queries: PredictionsQueries,
): Promise<BacktestEventOutcome> {
  try {
    const meta = await queries.loadTournamentMeta(tournamentId);
    if (!meta?.pickDeadline) {
      return {
        tournamentId, predictionRunId: null, metrics: null,
        error: 'tournament has no pick_deadline — cannot derive as-of-date',
      };
    }
    const asOfDate = dayBefore(meta.pickDeadline);

    // Run the predictor with the constrained as-of-date so the loaders
    // filter out future data.
    const predResult = await runPredictions({
      tournamentId,
      weightConfigId,
      statAsOfDate: asOfDate,
      triggeredBy,
    }, queries);

    const [actualResults, leagueOutcomes] = await Promise.all([
      queries.loadActualResults(tournamentId),
      queries.loadLeagueOutcomes(tournamentId),
    ]);

    if (actualResults.length === 0) {
      return {
        tournamentId,
        predictionRunId: predResult.runId,
        metrics: null,
        error: 'no actual results in scores table — tournament not yet scored',
      };
    }

    // Reclassify tier with the current OWGR snapshot.
    const topTierIds = computeTopTierIds(
      actualResults.map(r => ({ id: r.golferId, owgr_rank: r.owgrRank })),
    );
    const actualsWithTier: ActualGolferResult[] = actualResults.map(r => ({
      golferId:       r.golferId,
      fantasyScore:   r.fantasyScore,
      finishPosition: r.position,
      missedCut:      r.missedCut,
      isTopTier:      topTierIds.has(r.golferId),
    }));

    // Translate the orchestrator's foursome rows into the
    // RecommendedFoursome shape the metrics function expects.
    const recommendations: RecommendedFoursome[] = predResult.topFoursomes.map(f => ({
      rank:                  f.rank,
      topTier1Id:            f.topTier1Id,
      topTier2Id:            f.topTier2Id,
      darkHorse1Id:          f.darkHorse1Id,
      darkHorse2Id:          f.darkHorse2Id,
      projectedFantasyScore: f.projectedFantasyScore,
    }));

    const metrics = computeBacktestMetrics({
      recommendations,
      actualResults: actualsWithTier,
      leagueOutcomes: leagueOutcomes as LeagueMemberOutcome[],
    });

    return {
      tournamentId,
      predictionRunId: predResult.runId,
      metrics,
      error: null,
    };
  } catch (err) {
    return {
      tournamentId,
      predictionRunId: null,
      metrics: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
