// Tests for src/lib/predictions-orchestrator.ts.
//
// The orchestrator depends on the DB-backed PredictionsQueries
// interface. We inject a stub implementation per test, then assert on
// both the result AND the insert/mark calls the orchestrator made.
// No real DB, no Kysely — just typed inputs in, typed assertions out.

import { describe, it, expect, beforeEach } from 'vitest';
import { runPredictions, OrchestratorError } from '../src/lib/predictions-orchestrator';
import type {
  PredictionsQueries,
  RunPersistInput,
  GolferPredictionPersistRow,
  FoursomePersistRow,
  TournamentFieldRow,
} from '../src/lib/db/predictions-queries';
import type {
  CourseProfile, ScoringWeights, Finish,
  GolferStatRow, DatagolfPredsRow,
} from '../src/lib/course-fit';

// ── Default fixtures ──────────────────────────────────────

const DEFAULT_WEIGHTS: ScoringWeights = {
  courseFit:      0.30,
  recentForm:     0.20,
  longTerm:       0.15,
  courseHistory:  0.15,
  cutProbability: 0.10,
  upside:         0.10,
};

const DEFAULT_PROFILE: CourseProfile = {
  scoringDifficulty:           0,
  drivingDistanceImportance:   0.25,
  drivingAccuracyImportance:   0.25,
  approachImportance:          0.25,
  aroundGreenImportance:       0.25,
  puttingImportance:           0.25,
};

// 30-golfer field that crosses the per-field tier boundary
// (TOP_TIER_SIZE = 24 in field-tiers.ts). First 24 are top-tier,
// remaining 6 are dark-horse. Names prefixed t-/d- only for the test
// assertions about composition; the orchestrator computes tier from
// owgr_rank, not the id prefix.
function smallField(): TournamentFieldRow[] {
  const rows: TournamentFieldRow[] = [];
  for (let i = 0; i < 24; i++) {
    rows.push({ golferId: `t-${String.fromCharCode(65 + i)}`, owgrRank: i + 1 });
  }
  for (let i = 0; i < 6; i++) {
    rows.push({ golferId: `d-${String.fromCharCode(65 + i)}`, owgrRank: 50 + i * 20 });
  }
  return rows;
}

function defaultStats(): GolferStatRow {
  return {
    sg_total: 1.0, sg_ott: 0.3, sg_app: 0.4, sg_arg: 0.1, sg_putt: 0.2,
    driving_distance: 305, driving_accuracy_pct: 60, gir_pct: 70,
    scoring_avg: 70, birdie_avg: 4.0, bogey_avg: 2.5, made_cut_pct: 80,
  };
}

function defaultFinishes(): Finish[] {
  return [
    { position: 10, missedCut: false, eventDate: '2026-06-22' },
    { position: 25, missedCut: false, eventDate: '2026-06-15' },
    { position: 15, missedCut: false, eventDate: '2026-06-08' },
  ];
}

// ── Stub query implementation ──────────────────────────────

interface CapturedInserts {
  run?: RunPersistInput & { id: string };
  golfers: GolferPredictionPersistRow[];
  foursomes: FoursomePersistRow[];
  completedRunIds: string[];
  failedRunIds: { id: string; error: string }[];
}

interface StubOpts {
  weights?: { id: string; weights: ScoringWeights } | null;
  weightConfigById?: Record<string, { id: string; weights: ScoringWeights }>;
  courseProfile?: { id: string; profile: CourseProfile; comparableIds: string[] } | null;
  field?: TournamentFieldRow[];
  statsByGolfer?: Record<string, GolferStatRow | null>;
  datagolfByGolfer?: Record<string, DatagolfPredsRow | null>;
  finishesByGolfer?: Record<string, Finish[]>;
  ownership?: Map<string, number>;
  throwOnLoadFor?: string[];      // golfer ids whose load throws
  throwOnInsertGolfers?: boolean;
}

function makeStubQueries(opts: StubOpts = {}): {
  queries: PredictionsQueries; captured: CapturedInserts;
} {
  const captured: CapturedInserts = {
    golfers: [], foursomes: [], completedRunIds: [], failedRunIds: [],
  };
  const queries: PredictionsQueries = {
    async loadActiveWeightConfig() {
      if (opts.weights === undefined) {
        return { id: 'cfg-default', weights: DEFAULT_WEIGHTS };
      }
      return opts.weights;
    },
    async loadWeightConfig(id) {
      return opts.weightConfigById?.[id] ?? null;
    },
    async loadCourseProfile(_tournamentId) {
      if (opts.courseProfile !== undefined) return opts.courseProfile;
      return { id: 'cp-default', profile: DEFAULT_PROFILE, comparableIds: [] };
    },
    async loadTournamentField(_tournamentId) {
      return opts.field ?? smallField();
    },
    async loadLatestStatSnapshotDate() {
      // Tests don't exercise the live-default path; explicit
      // statAsOfDate (or its absence + tests not asserting date math)
      // is fine. Return null so the orchestrator falls through to
      // todayIsoDate() in test runs.
      return null;
    },
    async loadStatsSnapshot(golferId, _asOf) {
      if (opts.throwOnLoadFor?.includes(golferId)) throw new Error('boom');
      if (opts.statsByGolfer && golferId in opts.statsByGolfer) {
        return opts.statsByGolfer[golferId];
      }
      return defaultStats();
    },
    async loadDatagolfPreds(_tournamentId, golferId) {
      if (opts.datagolfByGolfer && golferId in opts.datagolfByGolfer) {
        return opts.datagolfByGolfer[golferId];
      }
      return null;
    },
    async loadRecentFinishes(golferId, _limit) {
      return opts.finishesByGolfer?.[golferId] ?? defaultFinishes();
    },
    async loadCourseHistory(_golferId, _courseProfileId, _limit) {
      return [];
    },
    async loadComparableHistory(_golferId, _profileIds, _limit) {
      return [];
    },
    async loadOwnership(_tournamentId) {
      return opts.ownership ?? new Map();
    },
    async insertRun(input) {
      const id = 'run-1';
      captured.run = { ...input, id };
      return id;
    },
    async insertGolferPredictions(rows) {
      if (opts.throwOnInsertGolfers) throw new Error('golfer insert boom');
      captured.golfers.push(...rows);
    },
    async insertFoursomes(rows) {
      captured.foursomes.push(...rows);
    },
    async markRunComplete(runId) {
      captured.completedRunIds.push(runId);
    },
    async markRunFailed(runId, error) {
      captured.failedRunIds.push({ id: runId, error });
    },
    // Backtest-path methods — not exercised by the orchestrator tests.
    // Throw if called so a future test that needs them gets a clear
    // error rather than silent null behavior.
    async loadTournamentMeta() { throw new Error('stub: loadTournamentMeta not exercised'); },
    async loadActualResults() { throw new Error('stub: loadActualResults not exercised'); },
    async loadLeagueOutcomes() { throw new Error('stub: loadLeagueOutcomes not exercised'); },
    async insertBacktestRun() { throw new Error('stub: insertBacktestRun not exercised'); },
    async insertBacktestResult() { throw new Error('stub: insertBacktestResult not exercised'); },
    async markBacktestComplete() { throw new Error('stub: markBacktestComplete not exercised'); },
    async markBacktestFailed() { throw new Error('stub: markBacktestFailed not exercised'); },
  };
  return { queries, captured };
}

// ── Happy path ─────────────────────────────────────────────

describe('runPredictions — happy path', () => {
  let stub: ReturnType<typeof makeStubQueries>;
  beforeEach(() => { stub = makeStubQueries(); });

  it('returns a runId and persists run + golfers + foursomes', async () => {
    const result = await runPredictions({ tournamentId: 't-1' }, stub.queries);
    expect(result.runId).toBe('run-1');
    expect(result.fieldSize).toBe(30);
    expect(result.golfersScored).toBe(30);
    expect(result.foursomesProduced).toBe(5);
    expect(stub.captured.run).toBeDefined();
    expect(stub.captured.golfers).toHaveLength(30);
    expect(stub.captured.foursomes).toHaveLength(5);
    expect(stub.captured.completedRunIds).toEqual(['run-1']);
    expect(stub.captured.failedRunIds).toEqual([]);
  });

  it('uses the active weight config when no id is specified', async () => {
    await runPredictions({ tournamentId: 't-1' }, stub.queries);
    expect(stub.captured.run?.weightConfigId).toBe('cfg-default');
  });

  it('stamps the triggering user onto the run', async () => {
    await runPredictions(
      { tournamentId: 't-1', triggeredBy: 'user-greg' },
      stub.queries,
    );
    expect(stub.captured.run?.triggeredBy).toBe('user-greg');
  });

  it('records field_size and golfer counts on the run row', async () => {
    await runPredictions({ tournamentId: 't-1' }, stub.queries);
    expect(stub.captured.run?.fieldSize).toBe(30);
    expect((stub.captured.run?.golfersWithCompleteStats ?? 0) +
           (stub.captured.run?.golfersWithMissingStats ?? 0)).toBe(30);
  });

  it('assigns ranks 1..5 to foursomes in ascending projected score', async () => {
    await runPredictions({ tournamentId: 't-1' }, stub.queries);
    const ranks = stub.captured.foursomes.map(f => f.rank);
    expect(ranks).toEqual([1, 2, 3, 4, 5]);
    for (let i = 1; i < stub.captured.foursomes.length; i++) {
      expect(stub.captured.foursomes[i].projectedFantasyScore)
        .toBeGreaterThanOrEqual(stub.captured.foursomes[i - 1].projectedFantasyScore);
    }
  });

  it('marks every foursome with a 2-top + 2-dark composition', async () => {
    await runPredictions({ tournamentId: 't-1' }, stub.queries);
    for (const f of stub.captured.foursomes) {
      expect(f.topTier1Id).toMatch(/^t-/);
      expect(f.topTier2Id).toMatch(/^t-/);
      expect(f.darkHorse1Id).toMatch(/^d-/);
      expect(f.darkHorse2Id).toMatch(/^d-/);
    }
  });
});

// ── Specified weight config ────────────────────────────────

describe('runPredictions — specified weight config', () => {
  it('uses the named weight config when an id is passed', async () => {
    const custom: ScoringWeights = {
      courseFit: 0.50, recentForm: 0.10, longTerm: 0.10,
      courseHistory: 0.10, cutProbability: 0.10, upside: 0.10,
    };
    const stub = makeStubQueries({
      weightConfigById: { 'cfg-custom': { id: 'cfg-custom', weights: custom } },
    });
    const result = await runPredictions(
      { tournamentId: 't-1', weightConfigId: 'cfg-custom' },
      stub.queries,
    );
    expect(result.runId).toBe('run-1');
    expect(stub.captured.run?.weightConfigId).toBe('cfg-custom');
  });

  it('throws NO_WEIGHT_CONFIG when the named config is missing', async () => {
    const stub = makeStubQueries({ weightConfigById: {} });
    await expect(runPredictions(
      { tournamentId: 't-1', weightConfigId: 'cfg-missing' },
      stub.queries,
    )).rejects.toMatchObject({ code: 'NO_WEIGHT_CONFIG' });
    expect(stub.captured.run).toBeUndefined();
  });
});

// ── Hard preconditions ─────────────────────────────────────

describe('runPredictions — preconditions', () => {
  it('throws NO_WEIGHT_CONFIG when there is no active config', async () => {
    const stub = makeStubQueries({ weights: null });
    await expect(runPredictions({ tournamentId: 't-1' }, stub.queries))
      .rejects.toBeInstanceOf(OrchestratorError);
    await expect(runPredictions({ tournamentId: 't-1' }, stub.queries))
      .rejects.toMatchObject({ code: 'NO_WEIGHT_CONFIG' });
  });

  it('throws NO_COURSE_PROFILE when the tournament has no profile', async () => {
    const stub = makeStubQueries({ courseProfile: null });
    await expect(runPredictions({ tournamentId: 't-1' }, stub.queries))
      .rejects.toMatchObject({ code: 'NO_COURSE_PROFILE' });
  });

  it('throws FIELD_TOO_SMALL when the field has < 4 golfers', async () => {
    const stub = makeStubQueries({
      field: [
        { golferId: 't-A', owgrRank: 1  },
        { golferId: 't-B', owgrRank: 5  },
        { golferId: 'd-A', owgrRank: 60 },
      ],
    });
    await expect(runPredictions({ tournamentId: 't-1' }, stub.queries))
      .rejects.toMatchObject({ code: 'FIELD_TOO_SMALL' });
  });
});

// ── Resilience: per-golfer load failure ────────────────────

describe('runPredictions — per-golfer load failures', () => {
  it('drops the failing golfer and continues if field stays >= 4', async () => {
    const stub = makeStubQueries({ throwOnLoadFor: ['d-A'] });
    const result = await runPredictions({ tournamentId: 't-1' }, stub.queries);
    expect(result.golfersScored).toBe(29);
    expect(stub.captured.foursomes).toHaveLength(5);
    // d-A should not appear in any foursome since its load threw.
    const seen = new Set<string>();
    for (const f of stub.captured.foursomes) {
      seen.add(f.topTier1Id); seen.add(f.topTier2Id);
      seen.add(f.darkHorse1Id); seen.add(f.darkHorse2Id);
    }
    expect(seen.has('d-A')).toBe(false);
  });

  it('errors with FIELD_TOO_SMALL when too many golfers drop', async () => {
    // Drop everyone except 3 — under the 4 minimum.
    const allIds = smallField().map(g => g.golferId);
    const stub = makeStubQueries({ throwOnLoadFor: allIds.slice(3) });
    await expect(runPredictions({ tournamentId: 't-1' }, stub.queries))
      .rejects.toMatchObject({ code: 'FIELD_TOO_SMALL' });
  });
});

// ── Persist failure handling ───────────────────────────────

describe('runPredictions — persist failure', () => {
  it('marks the run failed and rethrows when golfer insert blows up', async () => {
    const stub = makeStubQueries({ throwOnInsertGolfers: true });
    await expect(runPredictions({ tournamentId: 't-1' }, stub.queries))
      .rejects.toThrow(/golfer insert boom/);
    expect(stub.captured.run?.id).toBe('run-1');
    expect(stub.captured.failedRunIds).toEqual([
      { id: 'run-1', error: 'golfer insert boom' },
    ]);
    expect(stub.captured.completedRunIds).toEqual([]);
  });
});

// ── Missing-input aggregation ──────────────────────────────

describe('runPredictions — missing-input summary', () => {
  it('counts missing fields across all golfers', async () => {
    // Every golfer has NULL stats — should accumulate sg_total +
    // course_history etc. across all 8.
    const stub = makeStubQueries({
      statsByGolfer: Object.fromEntries(
        smallField().map(g => [g.golferId, null]),
      ),
    });
    const result = await runPredictions({ tournamentId: 't-1' }, stub.queries);
    // Every golfer flagged "stats" as missing → 30 occurrences.
    expect(result.missingInputsSummary.stats).toBe(30);
    expect(stub.captured.run?.golfersWithMissingStats).toBe(30);
    expect(stub.captured.run?.golfersWithCompleteStats).toBe(0);
  });
});

// ── Determinism ────────────────────────────────────────────

describe('runPredictions — determinism', () => {
  it('same inputs → identical foursome composition + order', async () => {
    const a = makeStubQueries();
    const b = makeStubQueries();
    const ra = await runPredictions({ tournamentId: 't-1' }, a.queries);
    const rb = await runPredictions({ tournamentId: 't-1' }, b.queries);
    expect(ra.topFoursomes.map(f => f.foursomeHash))
      .toEqual(rb.topFoursomes.map(f => f.foursomeHash));
  });
});
