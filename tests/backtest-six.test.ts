// Backtest: 6-man majors + the dropout / all-missed-cut scoring fixes
// (src/lib/backtest.ts). Pure functions, no I/O.

import { describe, it, expect } from 'vitest';
import {
  computeBacktestMetrics, __test,
  type ActualGolferResult, type RecommendedFoursome, type LeagueMemberOutcome,
} from '../src/lib/backtest';

const made = (id: string, score: number, top: boolean, finish = 10): ActualGolferResult =>
  ({ golferId: id, fantasyScore: score, finishPosition: finish, missedCut: false, isTopTier: top });
const mc = (id: string, top: boolean): ActualGolferResult =>
  ({ golferId: id, fantasyScore: 1, finishPosition: 999, missedCut: true, isTopTier: top });
const wd = (id: string, top: boolean): ActualGolferResult =>
  ({ golferId: id, fantasyScore: null, finishPosition: 999, missedCut: false, withdrew: true, isTopTier: top });

const four = (rank: number, ids: [string, string, string, string], proj = -20): RecommendedFoursome =>
  ({ rank, teamSize: 4, topTier1Id: ids[0], topTier2Id: ids[1], darkHorse1Id: ids[2], darkHorse2Id: ids[3], projectedFantasyScore: proj });
const six = (rank: number, ids: [string, string, string, string, string, string], proj = -25): RecommendedFoursome =>
  ({ rank, teamSize: 6, topTier1Id: ids[0], topTier2Id: ids[1], topTier3Id: ids[2],
     darkHorse1Id: ids[3], darkHorse2Id: ids[4], darkHorse3Id: ids[5], projectedFantasyScore: proj });

const byId = (rs: ActualGolferResult[]) => new Map(rs.map(r => [r.golferId, r]));

describe('realized team score — dropout and missed-cut rules', () => {
  const field = [made('a', -5, true), made('b', -3, true), mc('c', false), wd('d', false), made('e', 2, false)];
  it('a withdrawal is left out with no penalty (was: whole team scored null → 0)', () => {
    // a -5, b -3, e +2 count (best 3 of 3 remaining); d WD adds nothing
    expect(__test.realizeFoursomeScore(['a', 'b', 'd', 'e'], byId(field))).toBe(-6);
  });
  it('missed cut still adds the penalty', () => {
    expect(__test.realizeFoursomeScore(['a', 'b', 'c', 'e'], byId(field))).toBe(-6 + 1);
  });
  it('a team where nobody made the cut scores the penalties (was: 0, the best possible)', () => {
    const all = [mc('w', true), mc('x', true), mc('y', false), mc('z', false)];
    expect(__test.realizeFoursomeScore(['w', 'x', 'y', 'z'], byId(all))).toBe(4);
  });
  it('best 4 of 6 on six-man teams', () => {
    const f = [made('t1', -4, true), made('t2', -3, true), made('t3', 6, true),
               made('d1', -2, false), made('d2', -1, false), made('d3', 9, false)];
    expect(__test.realizeFoursomeScore(['t1', 't2', 't3', 'd1', 'd2', 'd3'], byId(f), 4)).toBe(-10);
  });
});

describe('findOptimalSixScore — exact vs brute force', () => {
  // Seeded field with made-cut, missed-cut and withdrawn golfers in both tiers.
  function fieldFor(seed: number): ActualGolferResult[] {
    let s = seed >>> 0;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const tier = (p: string, n: number, top: boolean) => Array.from({ length: n }, (_, i) => {
      const id = `${p}${i}`;
      const r = rnd();
      if (r < 0.2) return mc(id, top);
      if (r < 0.3) return wd(id, top);
      return made(id, Math.round((rnd() * 16 - 8) * 10) / 10, top);
    });
    return [...tier('t', 8, true), ...tier('d', 11, false)];
  }
  function brute(field: ActualGolferResult[]): number | null {
    const m = byId(field);
    const tri = (a: ActualGolferResult[]) => {
      const o: string[][] = [];
      for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++)
        for (let l = j + 1; l < a.length; l++) o.push([a[i].golferId, a[j].golferId, a[l].golferId]);
      return o;
    };
    let best: number | null = null;
    for (const t of tri(field.filter(r => r.isTopTier)))
      for (const d of tri(field.filter(r => !r.isTopTier))) {
        const v = __test.realizeFoursomeScore([...t, ...d], m, 4);
        if (v != null && (best == null || v < best)) best = v;
      }
    return best;
  }
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('seed %i', seed => {
    const f = fieldFor(seed);
    expect(__test.findOptimalSixScore(f)).toBeCloseTo(brute(f)!, 10);
  });
});

describe('computeBacktestMetrics — 6-man majors', () => {
  const field: ActualGolferResult[] = [
    made('t1', -8, true, 1), made('t2', -6, true, 3), made('t3', -2, true, 20), made('t4', 4, true, 50),
    made('d1', -5, false, 2), made('d2', -1, false, 25), made('d3', 1, false, 40), mc('d4', false),
  ];
  const recs = [
    four(1, ['t1', 't2', 'd1', 'd2']),                     // actual best 3: -8 -6 -5 = -19
    six(1, ['t1', 't2', 't3', 'd1', 'd2', 'd3']),         // actual best 4: -8 -6 -5 -2 = -21
  ];
  const leagues = (sizeX: 4 | 6, sizeY: 4 | 6): LeagueMemberOutcome[] => [
    { leagueId: 'X', userId: 'x1', golferIds: [], teamSize: sizeX, totalScore: -20 },
    { leagueId: 'X', userId: 'x2', golferIds: [], teamSize: sizeX, totalScore: -10 },
    { leagueId: 'Y', userId: 'y1', golferIds: [], teamSize: sizeY, totalScore: -20 },
    { leagueId: 'Y', userId: 'y2', golferIds: [], teamSize: sizeY, totalScore: -10 },
  ];

  it('all leagues 6-man → headline is the six-man team (best 4 of 6), regret vs 6-man optimum', () => {
    const m = computeBacktestMetrics({ recommendations: recs, actualResults: field, leagueOutcomes: leagues(6, 6) });
    expect(m.teamSize).toBe(6);
    expect(m.actualScore).toBe(-21);
    expect(m.projectedScore).toBe(-25);
    expect(m.regretScore).toBe(0);            // this six is the hindsight optimum
    expect(m.bestRecommendedRankInLeague).toBe(1);   // -21 beats -20 in both
    expect(m.beatLeagueWinner).toBe(true);
  });

  it('mixed leagues: each league judged against the model team of ITS size', () => {
    // X is 4-man: model four = -19 → loses to -20 (rank 2). Y is 6-man: model six = -21 → rank 1.
    const m = computeBacktestMetrics({ recommendations: recs, actualResults: field, leagueOutcomes: leagues(4, 6) });
    expect(m.teamSize).toBe(4);               // tie in league rows → headline 4
    expect(m.bestRecommendedRankInLeague).toBe(1.5);
    expect(m.beatLeagueWinner).toBe(false);   // 1 of 2 leagues, not a majority
  });

  it('no six-man recommendation → 6-man leagues are skipped, not compared to a foursome', () => {
    const m = computeBacktestMetrics({ recommendations: [recs[0]], actualResults: field, leagueOutcomes: leagues(4, 6) });
    expect(m.teamSize).toBe(4);
    expect(m.bestRecommendedRankInLeague).toBe(2);   // only league X compared
  });

  it('finish stats and sleeper accuracy use all six golfers / three dark horses', () => {
    const m = computeBacktestMetrics({ recommendations: recs, actualResults: field, leagueOutcomes: leagues(6, 6) });
    expect(m.madeCutPct).toBe(100);
    expect(m.avgFinishRecommended).toBeCloseTo((1 + 3 + 20 + 2 + 25 + 40) / 6, 10);
    // field 8 → top half = 4: d1 (2) yes, d2 (25) no, d3 (40) no
    expect(m.sleeperAccuracy).toBeCloseTo(1 / 3, 10);
  });
});
