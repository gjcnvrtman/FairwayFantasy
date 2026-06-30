// Tests for src/lib/backtest.ts — pure metric math.
//
// Inputs are typed fixtures (synthesized recommendations + actuals +
// league outcomes). Pure functions, no I/O.

import { describe, it, expect } from 'vitest';
import {
  computeBacktestMetrics, aggregateBacktestMetrics,
  type BacktestInputs, type ActualGolferResult,
  type LeagueMemberOutcome, type RecommendedFoursome,
  type BacktestEventMetrics,
} from '../src/lib/backtest';

// ── Fixture builders ───────────────────────────────────────

function actual(
  id: string, finish: number, fantasyScore: number,
  topTier = false, missedCut = false,
): ActualGolferResult {
  return {
    golferId: id,
    fantasyScore,
    finishPosition: finish,
    missedCut,
    isTopTier: topTier,
  };
}

function mc(id: string, topTier = false): ActualGolferResult {
  return actual(id, 999, 1, topTier, true);
}

function rec(rank: number, t1: string, t2: string, d1: string, d2: string,
             proj: number): RecommendedFoursome {
  return {
    rank,
    topTier1Id: t1, topTier2Id: t2,
    darkHorse1Id: d1, darkHorse2Id: d2,
    projectedFantasyScore: proj,
  };
}

function field(): ActualGolferResult[] {
  return [
    // Top tier (8 golfers)
    actual('t-A',  1, -18, true),  // winner
    actual('t-B',  4, -12, true),
    actual('t-C',  8, -8,  true),
    actual('t-D', 15, -4,  true),
    actual('t-E', 22, -2,  true),
    actual('t-F', 30,  0,  true),
    actual('t-G', 45,  3,  true),
    actual('t-H', 60,  5,  true),
    // Dark horses (12 golfers)
    actual('d-A',  2, -14),
    actual('d-B', 10, -6),
    actual('d-C', 18, -3),
    actual('d-D', 25, -1),
    actual('d-E', 35,  1),
    actual('d-F', 50,  4),
    actual('d-G', 70,  7),
    mc('d-H'),
    mc('d-I'),
    mc('d-J'),
    mc('d-K'),
    mc('d-L'),
  ];
}

function recsTopHeavy(): RecommendedFoursome[] {
  // Rank 1 picks the actual winner + 4th place + 2nd dark horse + decent dark
  return [
    rec(1, 't-A', 't-B', 'd-A', 'd-B', -42),
    rec(2, 't-A', 't-C', 'd-A', 'd-B', -38),
    rec(3, 't-B', 't-C', 'd-A', 'd-B', -36),
    rec(4, 't-A', 't-D', 'd-B', 'd-C', -32),
    rec(5, 't-B', 't-D', 'd-A', 'd-C', -30),
  ];
}

function leagueOutcomes(modelHashScore: number): LeagueMemberOutcome[] {
  return [
    // League X — 4 members
    { leagueId: 'lg-X', userId: 'u-1', golferIds: ['t-A', 't-B', 'd-A', 'd-B'], totalScore: modelHashScore },
    { leagueId: 'lg-X', userId: 'u-2', golferIds: ['t-A', 't-C', 'd-A', 'd-C'], totalScore: -34 },
    { leagueId: 'lg-X', userId: 'u-3', golferIds: ['t-B', 't-C', 'd-B', 'd-C'], totalScore: -25 },
    { leagueId: 'lg-X', userId: 'u-4', golferIds: ['t-A', 't-D', 'd-E', 'd-F'], totalScore: -20 },
    // League Y — 3 members
    { leagueId: 'lg-Y', userId: 'u-5', golferIds: ['t-A', 't-B', 'd-C', 'd-D'], totalScore: -28 },
    { leagueId: 'lg-Y', userId: 'u-6', golferIds: ['t-C', 't-D', 'd-D', 'd-E'], totalScore: -10 },
    { leagueId: 'lg-Y', userId: 'u-7', golferIds: ['t-A', 't-C', 'd-E', 'd-F'], totalScore: -22 },
  ];
}

// Compute model-#1 actual score manually for the fixture: takes
// t-A=-18, t-B=-12, d-A=-14, d-B=-6 → all made cut. Best 3 of 4 =
// -18 + -14 + -12 = -44. No MC penalty. Total = -44.
const MODEL_ACTUAL_SCORE = -44;

// ── Happy-path event metrics ───────────────────────────────

describe('computeBacktestMetrics — happy path', () => {
  const baseInputs = (): BacktestInputs => ({
    recommendations: recsTopHeavy(),
    actualResults: field(),
    leagueOutcomes: leagueOutcomes(MODEL_ACTUAL_SCORE),
  });
  const baseNoLeague = (): BacktestInputs => ({
    recommendations: recsTopHeavy(),
    actualResults: field(),
    leagueOutcomes: [],
  });

  it('actualScore == best-3-of-4 of the model #1 foursome', () => {
    const m = computeBacktestMetrics(baseInputs());
    expect(m.actualScore).toBe(MODEL_ACTUAL_SCORE);
    expect(m.totalFantasyPoints).toBe(MODEL_ACTUAL_SCORE);
  });

  it('projectedScore comes from the model #1 row', () => {
    const m = computeBacktestMetrics(baseNoLeague());
    expect(m.projectedScore).toBe(-42);
  });

  it('avgFinishRecommended averages the 4 finish positions', () => {
    const m = computeBacktestMetrics(baseNoLeague());
    // t-A=1, t-B=4, d-A=2, d-B=10 → avg = 4.25
    expect(m.avgFinishRecommended).toBeCloseTo(4.25, 2);
  });

  it('madeCutPct = 100 when all 4 made the cut', () => {
    const m = computeBacktestMetrics(baseNoLeague());
    expect(m.madeCutPct).toBe(100);
  });

  it('top10Pct counts recommended golfers with finish <= 10', () => {
    const m = computeBacktestMetrics(baseNoLeague());
    // t-A=1, t-B=4, d-A=2, d-B=10 → 4 of 4 in top-10
    expect(m.top10Pct).toBe(100);
  });

  it('top20Pct counts recommended golfers with finish <= 20', () => {
    const m = computeBacktestMetrics(baseNoLeague());
    expect(m.top20Pct).toBe(100);
  });

  it('sleeperAccuracy reflects dark-horse top-half rate', () => {
    const m = computeBacktestMetrics(baseNoLeague());
    // field has 20 golfers, top half cutoff = 10
    // d-A=2 (top half), d-B=10 (top half edge) → 2/2 = 1.0
    expect(m.sleeperAccuracy).toBe(1);
  });

  it('regretScore is non-negative (model can never beat hindsight optimal)', () => {
    const m = computeBacktestMetrics(baseNoLeague());
    expect(m.regretScore).toBeGreaterThanOrEqual(0);
  });
});

// ── League comparison ─────────────────────────────────────

describe('computeBacktestMetrics — league comparisons', () => {
  it('beat_league_average is TRUE when model_score < league avg in majority of leagues', () => {
    const inputs: BacktestInputs = {
      recommendations: recsTopHeavy(),
      actualResults: field(),
      leagueOutcomes: leagueOutcomes(MODEL_ACTUAL_SCORE),
    };
    const m = computeBacktestMetrics(inputs);
    // League X avg ≈ (-44 + -34 + -25 + -20) / 4 = -30.75; model -44 < -30.75 (yes)
    // League Y avg ≈ (-28 + -10 + -22) / 3 = -20.0; model -44 < -20 (yes)
    expect(m.beatLeagueAverage).toBe(true);
  });

  it('beat_league_winner reflects whether model beat best submitted in majority', () => {
    const inputs: BacktestInputs = {
      recommendations: recsTopHeavy(),
      actualResults: field(),
      leagueOutcomes: leagueOutcomes(MODEL_ACTUAL_SCORE),
    };
    const m = computeBacktestMetrics(inputs);
    // League X best submitted is -44 (user 1 picked same foursome) — model TIES, doesn't beat → false
    // League Y best submitted is -28 → model -44 < -28 → true
    // 1 of 2 leagues beaten → NOT majority → false
    expect(m.beatLeagueWinner).toBe(false);
  });

  it('rank averaged across leagues', () => {
    const inputs: BacktestInputs = {
      recommendations: recsTopHeavy(),
      actualResults: field(),
      leagueOutcomes: leagueOutcomes(MODEL_ACTUAL_SCORE),
    };
    const m = computeBacktestMetrics(inputs);
    // League X: model -44 ties with user 1's -44 → rank 1
    // League Y: model -44 beats all → rank 1
    // Avg = 1
    expect(m.bestRecommendedRankInLeague).toBe(1);
  });

  it('rank is N+1 when all members beat the model', () => {
    const inputs: BacktestInputs = {
      recommendations: [rec(1, 't-G', 't-H', 'd-G', 'd-H', 0)],   // model picks badly
      actualResults: field(),
      leagueOutcomes: [
        { leagueId: 'lg-X', userId: 'u-1', golferIds: ['t-A', 't-B', 'd-A', 'd-B'], totalScore: -44 },
        { leagueId: 'lg-X', userId: 'u-2', golferIds: ['t-A', 't-C', 'd-A', 'd-C'], totalScore: -34 },
      ],
    };
    const m = computeBacktestMetrics(inputs);
    // Model picks include MC golfer d-H + slow d-G → actual is a large positive
    expect(m.bestRecommendedRankInLeague).toBeGreaterThanOrEqual(3);
    expect(m.beatLeagueAverage).toBe(false);
    expect(m.beatLeagueWinner).toBe(false);
  });

  it('league fields are NULL when there are no league outcomes', () => {
    const inputs: BacktestInputs = {
      recommendations: recsTopHeavy(),
      actualResults: field(),
      leagueOutcomes: [],
    };
    const m = computeBacktestMetrics(inputs);
    expect(m.bestRecommendedRankInLeague).toBeNull();
    expect(m.beatLeagueAverage).toBeNull();
    expect(m.beatLeagueWinner).toBeNull();
  });
});

// ── Regret math ───────────────────────────────────────────

describe('computeBacktestMetrics — regret', () => {
  it('regret = 0 when model picked the actual optimal foursome', () => {
    const inputs: BacktestInputs = {
      // Build a field where t-A+t-B+d-A+d-B IS the unique optimum.
      // Other golfers all have terrible (large positive) scores.
      recommendations: [rec(1, 't-A', 't-B', 'd-A', 'd-B', -40)],
      actualResults: [
        actual('t-A', 1, -10, true),
        actual('t-B', 2, -8,  true),
        actual('t-C', 3, 20,  true),
        actual('t-D', 4, 25,  true),
        actual('d-A', 5, -6),
        actual('d-B', 6, -4),
        actual('d-C', 7, 30),
        actual('d-D', 8, 35),
      ],
      leagueOutcomes: [],
    };
    const m = computeBacktestMetrics(inputs);
    // Optimal = -10 + -8 + -6 = -24 (drop the -4 as worst-of-4 since
    // we take BEST 3, ascending sort → lowest 3 = -10, -8, -6)
    // Model actual = same.
    expect(m.regretScore).toBe(0);
  });

  it('regret > 0 when a better legal foursome existed in hindsight', () => {
    const inputs: BacktestInputs = {
      // Model picks t-D + t-E who scored badly when t-A + t-B were
      // available.
      recommendations: [rec(1, 't-D', 't-E', 'd-D', 'd-E', -10)],
      actualResults: field(),
      leagueOutcomes: [],
    };
    const m = computeBacktestMetrics(inputs);
    expect(m.regretScore).toBeGreaterThan(0);
  });
});

// ── Edge cases ────────────────────────────────────────────

describe('computeBacktestMetrics — edge cases', () => {
  it('returns zeros when no recommendations were produced', () => {
    const m = computeBacktestMetrics({
      recommendations: [],
      actualResults: field(),
      leagueOutcomes: [],
    });
    expect(m.actualScore).toBe(0);
    expect(m.bestRecommendedRankInLeague).toBeNull();
  });

  it('handles missed-cut golfers in the recommended set', () => {
    const inputs: BacktestInputs = {
      recommendations: [rec(1, 't-A', 't-B', 'd-H', 'd-I', -30)],   // d-H and d-I both MC
      actualResults: field(),
      leagueOutcomes: [],
    };
    const m = computeBacktestMetrics(inputs);
    // best 3 of (t-A=-18, t-B=-12, d-H=excluded_mc, d-I=excluded_mc)
    // = -18 + -12 = -30 + 2 MC penalty = -28
    expect(m.actualScore).toBe(-28);
    expect(m.madeCutPct).toBe(50);
  });

  it('handles golfers missing from the actuals map gracefully', () => {
    const inputs: BacktestInputs = {
      recommendations: [rec(1, 't-A', 'unknown-1', 'd-A', 'unknown-2', -40)],
      actualResults: field(),
      leagueOutcomes: [],
    };
    const m = computeBacktestMetrics(inputs);
    expect(m.actualScore).toBe(0);   // realizeFoursomeScore returned null → fallback 0
  });
});

// ── Aggregator ────────────────────────────────────────────

describe('aggregateBacktestMetrics', () => {
  function event(
    proj: number, actual: number, rank: number | null,
    beatAvg: boolean | null, beatWin: boolean | null,
    sleep: number,
  ): BacktestEventMetrics {
    return {
      projectedScore: proj, actualScore: actual,
      bestRecommendedRankInLeague: rank,
      beatLeagueAverage: beatAvg,
      beatLeagueWinner: beatWin,
      avgFinishRecommended: 10,
      madeCutPct: 100,
      top10Pct: 50,
      top20Pct: 75,
      totalFantasyPoints: actual,
      regretScore: 5,
      sleeperAccuracy: sleep,
    };
  }

  it('returns zeros on empty input', () => {
    const m = aggregateBacktestMetrics({ perEvent: [] });
    expect(m.eventsTested).toBe(0);
    expect(m.avgProjectedVsActual).toBe(0);
    expect(m.avgBestFoursomeRank).toBeNull();
  });

  it('avgProjectedVsActual = mean(proj - actual)', () => {
    const m = aggregateBacktestMetrics({ perEvent: [
      event(-40, -30, 5, true, false, 0.5),    // delta = -10
      event(-25, -20, 8, true, false, 0.0),    // delta =  -5
    ]});
    expect(m.avgProjectedVsActual).toBeCloseTo(-7.5, 2);
  });

  it('league-comparison metrics computed only over events that have them', () => {
    const m = aggregateBacktestMetrics({ perEvent: [
      event(-40, -30, 5, true, false, 0.5),
      event(-25, -20, null, null, null, 0.0),     // no league data
      event(-30, -25, 8, true, true, 1.0),
    ]});
    expect(m.eventsTested).toBe(3);
    expect(m.eventsWithCompleteData).toBe(2);
    expect(m.avgBestFoursomeRank).toBeCloseTo(6.5, 2);
    expect(m.pctBeatLeagueAverage).toBe(100);
    expect(m.pctBeatLeagueWinner).toBe(50);
  });

  it('avgSleeperAccuracy averages across ALL events (no null skipping)', () => {
    const m = aggregateBacktestMetrics({ perEvent: [
      event(-40, -30, null, null, null, 0.5),
      event(-25, -20, null, null, null, 1.0),
    ]});
    expect(m.avgSleeperAccuracy).toBeCloseTo(0.75, 2);
  });
});
