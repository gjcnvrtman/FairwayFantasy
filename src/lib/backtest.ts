// ============================================================
// BACKTEST METRICS ENGINE — pure functions, no I/O.
//
// Given:
//   - the model's top-5 recommended foursomes for a past tournament
//   - the ACTUAL fantasy_score per golfer in that event's field
//   - the picks every league member submitted for that event +
//     their actual realized totals
//
// computeBacktestMetrics() produces the per-event metric set the
// spec asks for:
//   - projected vs actual score for the model's #1 foursome
//   - rank of the model's #1 foursome had it been submitted to each
//     league, averaged across leagues
//   - beat-league-average / beat-league-winner (across all leagues
//     that played this tournament)
//   - avg finish position of the recommended golfers
//   - made-cut / top-10 / top-20 percentages across recommended
//   - total fantasy points for the model's #1
//   - regret score — gap to the OPTIMAL legal foursome computed
//     post-hoc with full knowledge of actual results
//   - sleeper accuracy — fraction of recommended dark-horses that
//     finished in the field's top half
//
// All scoring follows the league rules in src/lib/scoring.ts:
//   - best 3 of 4 golfer fantasy_scores
//   - + MISSED_CUT_PENALTY_STROKES × missed-cut count
//   - lower = better (golf)
//
// Pure functions — no DB, no clock. Callers (backtest-orchestrator.ts)
// load the inputs from real tables, but the math here is independent.
// ============================================================

import { computeFoursomeHash, MISSED_CUT_PENALTY_STROKES } from './scoring';

// ── Input types ─────────────────────────────────────────────

/** Actual outcome for one golfer in the tournament being backtested. */
export interface ActualGolferResult {
  golferId: string;
  /** Per-golfer score after the league rules applied (capped at cut
   *  line for made-cut, flat MISSED_CUT_PENALTY_STROKES for missed
   *  cut). Mirrors `scores.fantasy_score` semantics. NULL = no data
   *  available (golfer wasn't in field). */
  fantasyScore: number | null;
  /** Finish position from the actual leaderboard. 1..N. 999 for MC. */
  finishPosition: number;
  missedCut: boolean;
  isTopTier: boolean;
}

/** One league member's submitted pick + their total realized score. */
export interface LeagueMemberOutcome {
  leagueId: string;
  userId: string;
  /** The 4 golfer ids the member submitted, slot order irrelevant. */
  golferIds: [string, string, string, string];
  /** Final realized total per the league scoring rules. */
  totalScore: number;
}

/** One foursome the model recommended (rank 1..5). */
export interface RecommendedFoursome {
  rank: number;
  topTier1Id: string;
  topTier2Id: string;
  darkHorse1Id: string;
  darkHorse2Id: string;
  projectedFantasyScore: number;
}

export interface BacktestInputs {
  /** Top-5 from the model, rank-ordered 1..5. */
  recommendations: RecommendedFoursome[];
  /** Every golfer in the field with their actual realized score. */
  actualResults: ActualGolferResult[];
  /** Every league member's submitted pick + realized total for this
   *  tournament, across every league that played it. */
  leagueOutcomes: LeagueMemberOutcome[];
}

// ── Output type ─────────────────────────────────────────────

export interface BacktestEventMetrics {
  /** Model's #1 foursome projected score (lower = better). */
  projectedScore: number;
  /** Model's #1 foursome ACTUAL realized score using the league rules. */
  actualScore: number;

  /** Where the model's #1 ACTUAL score would have ranked in each
   *  league it was eligible for, averaged. 1 = would have won. NULL
   *  if no leagues played this event. */
  bestRecommendedRankInLeague: number | null;
  /** Did the model's #1 beat the average submitted pick? NULL if no
   *  league outcomes. */
  beatLeagueAverage: boolean | null;
  /** Did the model's #1 beat EVERY submitted pick? NULL if no league
   *  outcomes. */
  beatLeagueWinner: boolean | null;

  /** Average finish position across the 4 recommended golfers. MC
   *  counts as 999 — sentinel matches Finish convention. */
  avgFinishRecommended: number;
  madeCutPct: number;
  top10Pct: number;
  top20Pct: number;

  /** Sum of best-3 actual fantasy_scores from the #1 foursome plus
   *  MC penalty. Mirrors actualScore but spelled differently to
   *  match the schema column. */
  totalFantasyPoints: number;

  /** Gap to the optimal LEGAL foursome with full hindsight, computed
   *  by enumerating every (top-tier pair × dark-horse pair) over the
   *  field and selecting the minimum-actual-score one. */
  regretScore: number;

  /** Of the 2 dark-horses recommended in the #1 foursome, what
   *  fraction finished in the field's top half? */
  sleeperAccuracy: number;
}

// ── Internal helpers ────────────────────────────────────────

/** Apply the league total rule to a 4-golfer set's actual scores. */
function scoreFoursome(scores: number[], cutCount: number): number {
  if (scores.length === 0) return 0;
  const sorted = [...scores].sort((a, b) => a - b);
  // Best 3 of N (typically 3 of 4 when all 4 have data).
  const take = Math.min(3, sorted.length);
  const best3 = sorted.slice(0, take).reduce((a, b) => a + b, 0);
  return best3 + cutCount * MISSED_CUT_PENALTY_STROKES;
}

/** Compute the realized league total for an arbitrary 4-golfer set
 *  using a precomputed map of golferId → actual fantasy_score. */
function realizeFoursomeScore(
  golferIds: string[],
  byId: Map<string, ActualGolferResult>,
): number | null {
  const looked = golferIds.map(id => byId.get(id));
  if (looked.some(r => !r || r.fantasyScore == null)) return null;
  const scores: number[] = [];
  let cuts = 0;
  for (const r of looked) {
    if (!r) continue;
    if (r.missedCut) {
      cuts++;
      continue;        // missed-cut golfers excluded from top-3 pool
    }
    if (r.fantasyScore != null) scores.push(r.fantasyScore);
  }
  return scoreFoursome(scores, cuts);
}

/** Enumerate every legal (2 top × 2 dark) foursome over the actual
 *  field and find the minimum realized score. */
function findOptimalFoursomeScore(
  actualResults: ActualGolferResult[],
): number | null {
  const top = actualResults.filter(r => r.isTopTier);
  const dark = actualResults.filter(r => !r.isTopTier);
  if (top.length < 2 || dark.length < 2) return null;
  const byId = new Map<string, ActualGolferResult>(actualResults.map(r => [r.golferId, r]));

  let best: number | null = null;
  // Use index pairs for memory locality. Field sizes are tiny (~144).
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      for (let k = 0; k < dark.length; k++) {
        for (let l = k + 1; l < dark.length; l++) {
          const score = realizeFoursomeScore(
            [top[i].golferId, top[j].golferId, dark[k].golferId, dark[l].golferId],
            byId,
          );
          if (score == null) continue;
          if (best == null || score < best) best = score;
        }
      }
    }
  }
  return best;
}

// ── Public entry ────────────────────────────────────────────

export function computeBacktestMetrics(inputs: BacktestInputs): BacktestEventMetrics {
  const byId = new Map<string, ActualGolferResult>(
    inputs.actualResults.map(r => [r.golferId, r]),
  );

  // ── Pick the model's #1 foursome (rank 1) ──
  const top1 = inputs.recommendations.find(r => r.rank === 1)
            ?? inputs.recommendations[0]
            ?? null;
  if (!top1) {
    // Degenerate: no recommendations. Return zeros so the caller
    // gets a clean row rather than NaN soup.
    return {
      projectedScore: 0,
      actualScore: 0,
      bestRecommendedRankInLeague: null,
      beatLeagueAverage: null,
      beatLeagueWinner: null,
      avgFinishRecommended: 999,
      madeCutPct: 0,
      top10Pct: 0,
      top20Pct: 0,
      totalFantasyPoints: 0,
      regretScore: 0,
      sleeperAccuracy: 0,
    };
  }

  const top1Ids: [string, string, string, string] = [
    top1.topTier1Id, top1.topTier2Id, top1.darkHorse1Id, top1.darkHorse2Id,
  ];
  const top1ActualScore = realizeFoursomeScore(top1Ids, byId) ?? 0;

  // ── Per-recommended-golfer aggregates ──
  const recGolfers = top1Ids.map(id => byId.get(id)).filter(Boolean) as ActualGolferResult[];
  const avgFinish = recGolfers.length === 0
    ? 999
    : recGolfers.reduce((a, r) => a + r.finishPosition, 0) / recGolfers.length;
  const madeCutPct = recGolfers.length === 0
    ? 0
    : 100 * recGolfers.filter(r => !r.missedCut).length / recGolfers.length;
  const top10Pct = recGolfers.length === 0
    ? 0
    : 100 * recGolfers.filter(r => !r.missedCut && r.finishPosition <= 10).length / recGolfers.length;
  const top20Pct = recGolfers.length === 0
    ? 0
    : 100 * recGolfers.filter(r => !r.missedCut && r.finishPosition <= 20).length / recGolfers.length;

  // ── League ranking ──
  let bestRecRank: number | null = null;
  let beatAverage: boolean | null = null;
  let beatWinner: boolean | null = null;

  if (inputs.leagueOutcomes.length > 0) {
    // Per-league: compute where the model's score would have ranked.
    const byLeague = new Map<string, LeagueMemberOutcome[]>();
    for (const lm of inputs.leagueOutcomes) {
      const arr = byLeague.get(lm.leagueId) ?? [];
      arr.push(lm);
      byLeague.set(lm.leagueId, arr);
    }
    const recHash = computeFoursomeHash(top1Ids);
    const ranksAcrossLeagues: number[] = [];
    let beatAvgAcrossLeagues = 0;
    let leaguesBeatenForWinner = 0;
    for (const [, members] of byLeague) {
      const scores = members.map(m => m.totalScore);
      const memberHasModelPick = members.some(m =>
        computeFoursomeHash(m.golferIds) === recHash,
      );
      // Model's would-be rank in this league. If a member submitted
      // the same foursome, share the rank.
      const lowerCount = scores.filter(s => s < top1ActualScore).length;
      const tieCount = scores.filter(s => s === top1ActualScore).length;
      const rank = lowerCount + 1 + (memberHasModelPick && tieCount > 0 ? 0 : 0);
      ranksAcrossLeagues.push(rank);

      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      if (top1ActualScore < avg) beatAvgAcrossLeagues++;
      const winner = Math.min(...scores);
      if (top1ActualScore < winner) leaguesBeatenForWinner++;
    }
    bestRecRank = ranksAcrossLeagues.reduce((a, b) => a + b, 0) / ranksAcrossLeagues.length;
    // Strict majority — "tied in half the leagues" doesn't read as a
    // win. With 2 leagues, model has to beat both for a TRUE here.
    beatAverage = beatAvgAcrossLeagues > byLeague.size / 2;
    beatWinner = leaguesBeatenForWinner > byLeague.size / 2;
  }

  // ── Regret score ──
  const optimal = findOptimalFoursomeScore(inputs.actualResults);
  const regret = optimal == null ? 0 : top1ActualScore - optimal;

  // ── Sleeper accuracy: dark-horse top-half rate ──
  const darkHorses = [byId.get(top1.darkHorse1Id), byId.get(top1.darkHorse2Id)]
    .filter(Boolean) as ActualGolferResult[];
  const fieldSize = inputs.actualResults.length || 1;
  const top_half_cutoff = Math.ceil(fieldSize / 2);
  const sleeperHits = darkHorses.filter(r => !r.missedCut && r.finishPosition <= top_half_cutoff).length;
  const sleeperAccuracy = darkHorses.length === 0 ? 0 : sleeperHits / darkHorses.length;

  return {
    projectedScore:               top1.projectedFantasyScore,
    actualScore:                  top1ActualScore,
    bestRecommendedRankInLeague:  bestRecRank,
    beatLeagueAverage:            beatAverage,
    beatLeagueWinner:             beatWinner,
    avgFinishRecommended:         avgFinish,
    madeCutPct,
    top10Pct,
    top20Pct,
    totalFantasyPoints:           top1ActualScore,
    regretScore:                  regret,
    sleeperAccuracy,
  };
}

// ── Aggregator across many events ──────────────────────────

export interface AggregateInputs {
  perEvent: BacktestEventMetrics[];
}

export interface BacktestAggregateMetrics {
  eventsTested: number;
  /** events_with_complete_data — only events where we had enough to
   *  produce meaningful league-comparison metrics (i.e.
   *  bestRecommendedRankInLeague is non-null). */
  eventsWithCompleteData: number;
  avgProjectedVsActual: number;
  avgBestFoursomeRank: number | null;
  pctBeatLeagueAverage: number | null;
  pctBeatLeagueWinner: number | null;
  avgSleeperAccuracy: number;
}

export function aggregateBacktestMetrics(
  inputs: AggregateInputs,
): BacktestAggregateMetrics {
  const e = inputs.perEvent;
  if (e.length === 0) {
    return {
      eventsTested:               0,
      eventsWithCompleteData:     0,
      avgProjectedVsActual:       0,
      avgBestFoursomeRank:        null,
      pctBeatLeagueAverage:       null,
      pctBeatLeagueWinner:        null,
      avgSleeperAccuracy:         0,
    };
  }
  const withLeagueData = e.filter(m => m.bestRecommendedRankInLeague != null);
  const avgDelta = e.reduce((a, m) => a + (m.projectedScore - m.actualScore), 0) / e.length;
  const avgRank = withLeagueData.length === 0
    ? null
    : withLeagueData.reduce((a, m) => a + (m.bestRecommendedRankInLeague ?? 0), 0)
        / withLeagueData.length;
  const pctBeatAvg = withLeagueData.length === 0
    ? null
    : 100 * withLeagueData.filter(m => m.beatLeagueAverage).length / withLeagueData.length;
  const pctBeatWin = withLeagueData.length === 0
    ? null
    : 100 * withLeagueData.filter(m => m.beatLeagueWinner).length / withLeagueData.length;
  const avgSleeper = e.reduce((a, m) => a + m.sleeperAccuracy, 0) / e.length;
  return {
    eventsTested:               e.length,
    eventsWithCompleteData:     withLeagueData.length,
    avgProjectedVsActual:       avgDelta,
    avgBestFoursomeRank:        avgRank,
    pctBeatLeagueAverage:       pctBeatAvg,
    pctBeatLeagueWinner:        pctBeatWin,
    avgSleeperAccuracy:         avgSleeper,
  };
}
