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
//   - best 3 of 4 golfer fantasy_scores (best 4 of 6 on 6-man majors)
//   - + MISSED_CUT_PENALTY_STROKES × missed-cut count
//   - withdrawn / DQ golfers: left out, no penalty (dropout rule)
//   - lower = better (golf)
//
// 6-man majors: each league is compared against the recommendation of
// its own team size. The headline numbers (projected/actual/regret/
// finish stats) use the team size most leagues played for the event.
//
// Pure functions — no DB, no clock. Callers (backtest-orchestrator.ts)
// load the inputs from real tables, but the math here is independent.
// ============================================================

import { MISSED_CUT_PENALTY_STROKES } from './scoring';

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
  /** Withdrew / DQ'd: left out of the team score with no penalty. */
  withdrew?: boolean;
  isTopTier: boolean;
}

/** One league member's submitted pick + their total realized score. */
export interface LeagueMemberOutcome {
  leagueId: string;
  userId: string;
  /** The golfer ids that counted (4, or 6 on a 6-man major), slot order irrelevant. */
  golferIds: string[];
  /** Default 4. */
  teamSize?: 4 | 6;
  /** Final realized total per the league scoring rules. */
  totalScore: number;
}

/** One team the model recommended (rank 1..5 within its team size). */
export interface RecommendedFoursome {
  rank: number;
  /** Default 4. */
  teamSize?: 4 | 6;
  topTier1Id: string;
  topTier2Id: string;
  darkHorse1Id: string;
  darkHorse2Id: string;
  /** 6-man teams only. */
  topTier3Id?: string | null;
  darkHorse3Id?: string | null;
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
  /** Team size the headline numbers below are for (4 or 6). */
  teamSize: 4 | 6;
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

/** Apply the league total rule: best `counting` of the made-cut scores
 *  + penalty per missed cut. */
function scoreFoursome(scores: number[], cutCount: number, counting = 3): number {
  if (scores.length === 0) return cutCount * MISSED_CUT_PENALTY_STROKES;
  const sorted = [...scores].sort((a, b) => a - b);
  // Best N of what's left (3 of 4, or 4 of 6 on 6-man majors).
  const take = Math.min(counting, sorted.length);
  const best = sorted.slice(0, take).reduce((a, b) => a + b, 0);
  return best + cutCount * MISSED_CUT_PENALTY_STROKES;
}

/** Compute the realized league total for an arbitrary team using a
 *  precomputed map of golferId → actual result. Withdrawn / DQ golfers
 *  are left out with no penalty (dropout rule, 2026-09-28) — before
 *  that fix a team with a WD came back null here and a #1 pick with a
 *  WD was recorded as an actual score of 0. */
function realizeFoursomeScore(
  golferIds: string[],
  byId: Map<string, ActualGolferResult>,
  counting = 3,
): number | null {
  const looked = golferIds.map(id => byId.get(id));
  if (looked.some(r => !r)) return null;
  const scores: number[] = [];
  let cuts = 0;
  for (const r of looked) {
    if (!r || r.withdrew) continue;       // dropout: no score, no penalty
    if (r.missedCut) {
      cuts++;
      continue;        // missed-cut golfers excluded from the best-N pool
    }
    if (r.fantasyScore == null) return null;   // no data for an active golfer
    scores.push(r.fantasyScore);
  }
  return scoreFoursome(scores, cuts, counting);
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

/**
 * Best possible 6-man team (3 top + 3 dark, best 4 of 6) with hindsight.
 * Exhaustive is ~700M teams, so reduce each tier first — exactly:
 * made-cut golfers only help through their score (lower is better), so
 * only the 3 lowest per tier can be in an optimal team; missed-cut
 * golfers are interchangeable (each adds the penalty), as are dropouts
 * (each adds nothing) — 3 of each suffice. ≤ 9 per tier → ≤ 7,056 teams.
 * Golfers with no data are skipped (a team with one can't be scored).
 */
function findOptimalSixScore(actualResults: ActualGolferResult[]): number | null {
  const byId = new Map<string, ActualGolferResult>(actualResults.map(r => [r.golferId, r]));
  const reduce = (tier: ActualGolferResult[]) => {
    const byIdOrder = (a: ActualGolferResult, b: ActualGolferResult) => a.golferId.localeCompare(b.golferId);
    const made = tier.filter(r => !r.withdrew && !r.missedCut && r.fantasyScore != null)
      .sort((a, b) => a.fantasyScore! - b.fantasyScore! || byIdOrder(a, b)).slice(0, 3);
    const mc = tier.filter(r => !r.withdrew && r.missedCut).sort(byIdOrder).slice(0, 3);
    const wd = tier.filter(r => r.withdrew).sort(byIdOrder).slice(0, 3);
    return [...made, ...mc, ...wd];
  };
  const top = reduce(actualResults.filter(r => r.isTopTier));
  const dark = reduce(actualResults.filter(r => !r.isTopTier));
  if (top.length < 3 || dark.length < 3) return null;

  const tri = (a: ActualGolferResult[]) => {
    const out: string[][] = [];
    for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++)
      for (let l = j + 1; l < a.length; l++) out.push([a[i].golferId, a[j].golferId, a[l].golferId]);
    return out;
  };
  let best: number | null = null;
  for (const t of tri(top)) {
    for (const d of tri(dark)) {
      const score = realizeFoursomeScore([...t, ...d], byId, 4);
      if (score != null && (best == null || score < best)) best = score;
    }
  }
  return best;
}

const sizeOf = (x: { teamSize?: 4 | 6 }): 4 | 6 => x.teamSize ?? 4;
const countingFor = (size: 4 | 6) => (size === 6 ? 4 : 3);
const teamIds = (r: RecommendedFoursome): string[] => [
  r.topTier1Id, r.topTier2Id, ...(r.topTier3Id ? [r.topTier3Id] : []),
  r.darkHorse1Id, r.darkHorse2Id, ...(r.darkHorse3Id ? [r.darkHorse3Id] : []),
];
const darkIds = (r: RecommendedFoursome): string[] =>
  [r.darkHorse1Id, r.darkHorse2Id, ...(r.darkHorse3Id ? [r.darkHorse3Id] : [])];

// ── Public entry ────────────────────────────────────────────

export function computeBacktestMetrics(inputs: BacktestInputs): BacktestEventMetrics {
  const byId = new Map<string, ActualGolferResult>(
    inputs.actualResults.map(r => [r.golferId, r]),
  );

  // Headline team size: what most leagues played (ties → 4), provided
  // the model produced that size.
  const sixLeagueRows = inputs.leagueOutcomes.filter(m => sizeOf(m) === 6).length;
  const fourLeagueRows = inputs.leagueOutcomes.length - sixLeagueRows;
  const hasSix = inputs.recommendations.some(r => sizeOf(r) === 6);
  const headline: 4 | 6 = hasSix && sixLeagueRows > fourLeagueRows ? 6 : 4;
  const rank1Of = (size: 4 | 6) => {
    const ofSize = inputs.recommendations.filter(r => sizeOf(r) === size);
    return ofSize.find(r => r.rank === 1) ?? ofSize[0] ?? null;
  };

  // ── Pick the model's #1 team (rank 1) of the headline size ──
  const top1 = rank1Of(headline);
  if (!top1) {
    // Degenerate: no recommendations. Return zeros so the caller
    // gets a clean row rather than NaN soup.
    return {
      teamSize: headline,
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

  const top1Ids = teamIds(top1);
  const top1ActualScore = realizeFoursomeScore(top1Ids, byId, countingFor(headline)) ?? 0;

  // ── Per-recommended-golfer aggregates ──
  const recGolfers = top1Ids.map(id => byId.get(id)).filter(Boolean) as ActualGolferResult[];
  const madeIt = (r: ActualGolferResult) => !r.missedCut && !r.withdrew;
  const avgFinish = recGolfers.length === 0
    ? 999
    : recGolfers.reduce((a, r) => a + r.finishPosition, 0) / recGolfers.length;
  const madeCutPct = recGolfers.length === 0
    ? 0
    : 100 * recGolfers.filter(madeIt).length / recGolfers.length;
  const top10Pct = recGolfers.length === 0
    ? 0
    : 100 * recGolfers.filter(r => madeIt(r) && r.finishPosition <= 10).length / recGolfers.length;
  const top20Pct = recGolfers.length === 0
    ? 0
    : 100 * recGolfers.filter(r => madeIt(r) && r.finishPosition <= 20).length / recGolfers.length;

  // Each league is judged against the model's #1 of ITS team size.
  const actualBySize = new Map<4 | 6, number | null>();
  const modelActualFor = (size: 4 | 6): number | null => {
    if (!actualBySize.has(size)) {
      const rec = rank1Of(size);
      actualBySize.set(size, rec ? realizeFoursomeScore(teamIds(rec), byId, countingFor(size)) ?? 0 : null);
    }
    return actualBySize.get(size)!;
  };

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
    const ranksAcrossLeagues: number[] = [];
    let beatAvgAcrossLeagues = 0;
    let leaguesBeatenForWinner = 0;
    let leaguesCompared = 0;
    for (const [, members] of byLeague) {
      const modelScore = modelActualFor(sizeOf(members[0]));
      if (modelScore == null) continue;        // model made no team of this league's size
      leaguesCompared++;
      const scores = members.map(m => m.totalScore);
      // Model's would-be rank in this league (ties share the rank).
      const lowerCount = scores.filter(s => s < modelScore).length;
      ranksAcrossLeagues.push(lowerCount + 1);

      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      if (modelScore < avg) beatAvgAcrossLeagues++;
      const winner = Math.min(...scores);
      if (modelScore < winner) leaguesBeatenForWinner++;
    }
    if (leaguesCompared > 0) {
      bestRecRank = ranksAcrossLeagues.reduce((a, b) => a + b, 0) / ranksAcrossLeagues.length;
      // Strict majority — "tied in half the leagues" doesn't read as a
      // win. With 2 leagues, model has to beat both for a TRUE here.
      beatAverage = beatAvgAcrossLeagues > leaguesCompared / 2;
      beatWinner = leaguesBeatenForWinner > leaguesCompared / 2;
    }
  }

  // ── Regret score ──
  const optimal = headline === 6
    ? findOptimalSixScore(inputs.actualResults)
    : findOptimalFoursomeScore(inputs.actualResults);
  const regret = optimal == null ? 0 : top1ActualScore - optimal;

  // ── Sleeper accuracy: dark-horse top-half rate ──
  const darkHorses = darkIds(top1).map(id => byId.get(id))
    .filter(Boolean) as ActualGolferResult[];
  const fieldSize = inputs.actualResults.length || 1;
  const top_half_cutoff = Math.ceil(fieldSize / 2);
  const sleeperHits = darkHorses.filter(r => madeIt(r) && r.finishPosition <= top_half_cutoff).length;
  const sleeperAccuracy = darkHorses.length === 0 ? 0 : sleeperHits / darkHorses.length;

  return {
    teamSize:                     headline,
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

/** Internal helpers exposed for tests. */
export const __test = { realizeFoursomeScore, findOptimalFoursomeScore, findOptimalSixScore };

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
