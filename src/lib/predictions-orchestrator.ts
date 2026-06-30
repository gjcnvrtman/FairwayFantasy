// ============================================================
// PREDICTIONS ORCHESTRATOR — one full prediction run, end-to-end.
//
// Glues the pure scoring layer (src/lib/course-fit.ts +
// src/lib/lineup-optimizer.ts) to the DB query layer
// (src/lib/db/predictions-queries.ts). Used by:
//
//   - POST /api/predictions/runs                  (admin-triggered)
//   - the predictions UI "Re-run" button         (Phase 3 UI slice)
//
// Steps:
//   1. Resolve weight config (active or specified-by-id)
//   2. Resolve course profile (refuse if NULL — predictor needs one)
//   3. Resolve field (scores table preferred; DG preds fallback)
//   4. Compute per-tournament tier classification (field-tiers.ts)
//   5. Per-golfer, load inputs in parallel (stats / DG / finishes / history)
//   6. Score each golfer via course-fit.scoreGolfer
//   7. Build optimizer inputs + rank top 5
//   8. Persist run row + per-golfer predictions + foursomes
//   9. Mark run complete OR (on failure) mark run failed with error
//
// On failure mid-step (e.g. one golfer's data load throws), we catch
// and continue with that golfer EXCLUDED — the run still produces a
// usable top-5 against the remaining field. A run is marked 'failed'
// only when something unrecoverable happens (no weight config, no
// course profile, no eligible field, insert error).
//
// Determinism: same DB state + same opts produce identical output.
// ============================================================

import {
  scoreGolfer,
  type GolferSubscores,
  type ScoringWeights,
} from './course-fit';
import { rankTop5, type OptimizerGolfer } from './lineup-optimizer';
import { computeTopTierIds } from './field-tiers';
import type {
  PredictionsQueries,
  GolferPredictionPersistRow,
  FoursomePersistRow,
} from './db/predictions-queries';

// ── Inputs / outputs ─────────────────────────────────────────

export interface OrchestrateOptions {
  tournamentId: string;
  /** Defaults to the active weight config. */
  weightConfigId?: string;
  /** ISO YYYY-MM-DD. Defaults to today (UTC). */
  statAsOfDate?: string;
  /** profile UUID for "course history at this venue" lookups —
   *  the orchestrator resolves it from the tournament. */
  triggeredBy?: string | null;
}

export interface OrchestrateResult {
  runId: string;
  fieldSize: number;
  golfersScored: number;
  foursomesProduced: number;
  missingInputsSummary: Record<string, number>;
  /** Snapshot of the top-5 written, for the immediate caller's
   *  convenience. The full read path goes through the
   *  /api/predictions/runs/[id] endpoint. */
  topFoursomes: FoursomePersistRow[];
}

export class OrchestratorError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

// ── Helpers ──────────────────────────────────────────────────

function todayIsoDate(): string {
  // YYYY-MM-DD in UTC. The scorer only cares about ordering for
  // snapshot lookup, so UTC is fine.
  return new Date().toISOString().slice(0, 10);
}

function aggregateMissing(
  perGolfer: GolferSubscores[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of perGolfer) {
    for (const m of s.missingInputs) {
      out[m] = (out[m] ?? 0) + 1;
    }
  }
  return out;
}

// ── Main entry point ─────────────────────────────────────────

export async function runPredictions(
  opts: OrchestrateOptions,
  queries: PredictionsQueries,
): Promise<OrchestrateResult> {

  // 1 — weights
  const weightsRow = opts.weightConfigId
    ? await queries.loadWeightConfig(opts.weightConfigId)
    : await queries.loadActiveWeightConfig();
  if (!weightsRow) {
    throw new OrchestratorError(
      'NO_WEIGHT_CONFIG',
      opts.weightConfigId
        ? `Weight config ${opts.weightConfigId} not found`
        : 'No active weight config — seed v1-default or activate a config',
    );
  }
  const weights: ScoringWeights = weightsRow.weights;

  // 2 — course profile (id + profile + comparable refs bundled)
  const courseRow = await queries.loadCourseProfile(opts.tournamentId);
  if (!courseRow) {
    throw new OrchestratorError(
      'NO_COURSE_PROFILE',
      `Tournament ${opts.tournamentId} has no course profile — curate one in /predictions/courses first`,
    );
  }
  const { id: courseProfileId, profile: course, comparableIds } = courseRow;

  // 3 — field
  const field = await queries.loadTournamentField(opts.tournamentId);
  if (field.length < 4) {
    throw new OrchestratorError(
      'FIELD_TOO_SMALL',
      `Tournament field has ${field.length} golfers — need at least 4 (2 top-tier + 2 dark-horse)`,
    );
  }

  // 4 — per-tournament tier classification
  const topTierIds = computeTopTierIds(
    field.map(g => ({ id: g.golferId, owgr_rank: g.owgrRank })),
  );

  // 5 — load per-golfer inputs (parallel; one slow load doesn't
  // serialize the others)
  const asOf = opts.statAsOfDate ?? todayIsoDate();
  const perGolferLoad = await Promise.all(field.map(async g => {
    try {
      const [stats, dg, recent, history, comparable] = await Promise.all([
        queries.loadStatsSnapshot(g.golferId, asOf),
        queries.loadDatagolfPreds(opts.tournamentId, g.golferId),
        queries.loadRecentFinishes(g.golferId, 6),
        queries.loadCourseHistory(g.golferId, courseProfileId, 5),
        queries.loadComparableHistory(g.golferId, comparableIds, 5),
      ]);
      return {
        ok: true as const,
        golferId: g.golferId,
        owgrRank: g.owgrRank,
        stats, datagolf: dg, recentFinishes: recent,
        courseHistory: history, comparableHistory: comparable,
      };
    } catch (err) {
      // One golfer's load failure shouldn't kill the run. Drop them
      // from this run's field and continue with the rest.
      return { ok: false as const, golferId: g.golferId, error: err };
    }
  }));

  const loaded = perGolferLoad.filter(x => x.ok) as Extract<typeof perGolferLoad[number], { ok: true }>[];
  if (loaded.length < 4) {
    throw new OrchestratorError(
      'FIELD_TOO_SMALL',
      `After per-golfer load errors, only ${loaded.length} golfers remain — need 4+`,
    );
  }

  // 6 — score each golfer
  const scored = loaded.map(g => {
    const subscores = scoreGolfer(
      {
        golferId:          g.golferId,
        owgrRank:          g.owgrRank,
        stats:             g.stats,
        datagolf:          g.datagolf,
        recentFinishes:    g.recentFinishes,
        courseHistory:     g.courseHistory,
        comparableHistory: g.comparableHistory,
      },
      course,
      weights,
    );
    return {
      golferId:   g.golferId,
      isTopTier:  topTierIds.has(g.golferId),
      subscores,
    };
  });

  // 7 — build optimizer inputs + rank
  const ownership = await queries.loadOwnership(opts.tournamentId);
  const topFiveOpt = rankTop5({
    golfers: scored.map<OptimizerGolfer>(s => ({
      id:         s.golferId,
      isTopTier:  s.isTopTier,
      subscores:  s.subscores,
    })),
    ownership,
  });

  // 8 — persist the run row first (so per-golfer + foursome inserts
  // have a parent to reference)
  const missingSummary = aggregateMissing(scored.map(s => s.subscores));
  const golfersWithMissing = scored.filter(s => s.subscores.missingInputs.length > 0).length;
  const runId = await queries.insertRun({
    tournamentId:                opts.tournamentId,
    weightConfigId:              weightsRow.id,
    statAsOfDate:                asOf,
    fieldSize:                   field.length,
    golfersWithCompleteStats:    scored.length - golfersWithMissing,
    golfersWithMissingStats:     golfersWithMissing,
    missingInputs:               missingSummary,
    triggeredBy:                 opts.triggeredBy ?? null,
  });

  // 8a — persist per-golfer predictions
  const golferRows: GolferPredictionPersistRow[] = scored.map(s => ({
    runId,
    golferId:               s.golferId,
    isTopTier:              s.isTopTier,
    courseFit:              s.subscores.courseFit,
    recentForm:             s.subscores.recentForm,
    longTerm:               s.subscores.longTerm,
    courseHistory:          s.subscores.courseHistory,
    cutProbability:         s.subscores.cutProbability,
    upside:                 s.subscores.upside,
    composite:              s.subscores.composite,
    projectedStrokesToPar:  s.subscores.projectedStrokesToPar,
    projectedCutMadeProb:   s.subscores.projectedCutProb,
    explanation:            s.subscores.explanation,
  }));

  // 8b — persist foursomes
  const foursomeRows: FoursomePersistRow[] = topFiveOpt.map((f, idx) => ({
    runId,
    rank:                     idx + 1,
    topTier1Id:               f.topTier1Id,
    topTier2Id:               f.topTier2Id,
    darkHorse1Id:             f.darkHorse1Id,
    darkHorse2Id:             f.darkHorse2Id,
    foursomeHash:             f.foursomeHash,
    projectedFantasyScore:    f.projectedFantasyScore,
    confidenceScore:          f.confidenceScore,
    riskLevel:                f.riskLevel,
    estimatedOwnershipPct:    f.estimatedOwnershipPct,
    keyStrengths:             f.keyStrengths,
    keyConcerns:              f.keyConcerns,
    foursomeExplanation:      f.foursomeExplanation,
  }));

  try {
    await queries.insertGolferPredictions(golferRows);
    await queries.insertFoursomes(foursomeRows);
    await queries.markRunComplete(runId);
  } catch (err) {
    // Persist failure mid-write — mark the run failed and rethrow so
    // the caller can surface a clean error to the admin.
    await queries.markRunFailed(runId, err instanceof Error ? err.message : String(err));
    throw err;
  }

  return {
    runId,
    fieldSize:              field.length,
    golfersScored:          scored.length,
    foursomesProduced:      foursomeRows.length,
    missingInputsSummary:   missingSummary,
    topFoursomes:           foursomeRows,
  };
}

