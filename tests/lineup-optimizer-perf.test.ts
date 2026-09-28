// The pruned 4-man / 6-man searches must return exactly what an
// exhaustive search returns — same teams, same scores, same order,
// including hash-tiebreak order on exact score ties (perf change
// 2026-09-28: 4-man went from ~5 s to a few ms on a real field).

import { describe, it, expect } from 'vitest';
import { rankTopK, rankTopKSix, __test, type OptimizerGolfer } from '../src/lib/lineup-optimizer';
import { computeFoursomeHash } from '../src/lib/scoring';

function golfer(id: string, top: boolean, strokes: number, cut: number): OptimizerGolfer {
  return {
    id, isTopTier: top,
    subscores: {
      courseFit: 50, recentForm: 50, longTerm: 50, courseHistory: 50, cutProbability: 50,
      upside: 50, composite: 50, missingInputs: [], explanation: '',
      projectedStrokesToPar: strokes, projectedCutProb: cut,
    },
  };
}

/** Seeded field. `coarse` rounds values to a few levels so many teams
 *  tie exactly and the hash tiebreak decides the order. */
function field(seed: number, nTop: number, nDark: number, coarse: boolean): OptimizerGolfer[] {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const q = (v: number, step: number) => (coarse ? Math.round(v / step) * step : Number(v.toFixed(3)));
  const make = (p: string, n: number, top: boolean) => Array.from({ length: n }, (_, i) =>
    golfer(`${p}${String(i).padStart(2, '0')}`, top,
      q((top ? -3 : 0) + rnd() * 5, 1), q(0.4 + rnd() * 0.55, 0.25)));
  return [...make('t', nTop, true), ...make('d', nDark, false)];
}

/** The pre-optimization algorithm: score every team, sort by (score, hash). */
function exhaustive(golfers: OptimizerGolfer[], size: 4 | 6, k: number) {
  const sorted = [...golfers].sort((a, b) => a.id.localeCompare(b.id));
  const choose = <T,>(a: T[], r: number): T[][] => r === 0 ? [[]]
    : a.flatMap((x, i) => choose(a.slice(i + 1), r - 1).map(rest => [x, ...rest]));
  const per = size === 6 ? 3 : 2;
  const all: Array<{ score: number; hash: string }> = [];
  for (const t of choose(sorted.filter(g => g.isTopTier), per))
    for (const d of choose(sorted.filter(g => !g.isTopTier), per)) {
      const team = [...t, ...d];
      all.push({
        score: size === 6 ? __test.projectedSixScore(team) : __test.projectedFantasyScore(team),
        hash: computeFoursomeHash(team.map(g => g.id)),
      });
    }
  all.sort((a, b) => (a.score - b.score) || a.hash.localeCompare(b.hash));
  return all.slice(0, k);
}

const cases: Array<[number, boolean]> = [[1, false], [2, false], [3, true], [4, true], [5, true], [6, false]];

describe('pruned search == exhaustive search (incl. tie order)', () => {
  it.each(cases)('4-man, seed %i, coarse=%s', (seed, coarse) => {
    const g = field(seed, 12, 26, coarse);
    for (const k of [1, 5, 8]) {
      expect(rankTopK({ golfers: g }, k).map(f => ({ score: f.projectedFantasyScore, hash: f.foursomeHash })))
        .toEqual(exhaustive(g, 4, k));
    }
  });
  it.each(cases)('6-man, seed %i, coarse=%s', (seed, coarse) => {
    const g = field(seed, 8, 13, coarse);
    expect(rankTopKSix({ golfers: g }, 5).map(f => ({ score: f.projectedFantasyScore, hash: f.foursomeHash })))
      .toEqual(exhaustive(g, 6, 5));
  });
  it('coarse fields really do produce score ties (so tie order is being tested)', () => {
    const top = exhaustive(field(3, 12, 26, true), 4, 8).map(r => r.score);
    expect(new Set(top).size).toBeLessThan(top.length);
  });
});
