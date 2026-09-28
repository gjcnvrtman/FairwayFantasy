// Tests for the 6-man major lineup optimizer (3 top-tier + 3 dark
// horse, best 4 of 6) in src/lib/lineup-optimizer.ts. The key test
// compares the pruned search against brute force on seeded fields.

import { describe, it, expect } from 'vitest';
import {
  rankTop5Six, rankTopKSix, pruneDominated, rankTop5, __test,
  type OptimizerGolfer, type OptimizerInputs,
} from '../src/lib/lineup-optimizer';
import { computeFoursomeHash } from '../src/lib/scoring';
import type { GolferSubscores } from '../src/lib/course-fit';

function golfer(id: string, isTopTier: boolean, strokes: number, cutProb: number,
                extra: Partial<GolferSubscores> = {}): OptimizerGolfer {
  return {
    id, isTopTier,
    subscores: {
      courseFit: 50, recentForm: 50, longTerm: 50, courseHistory: 50,
      cutProbability: 70, upside: 50, composite: 55, missingInputs: [],
      projectedStrokesToPar: strokes, projectedCutProb: cutProb, explanation: '',
      ...extra,
    },
  };
}

/** Deterministic pseudo-random field. `correlated` ties strokes to cut
 *  prob like the real model; false makes them independent (worst case
 *  for pruning). */
function seededField(seed: number, nTop: number, nDark: number, correlated: boolean): OptimizerInputs {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const make = (prefix: string, n: number, top: boolean) =>
    Array.from({ length: n }, (_, i) => {
      const skill = rnd();
      const strokes = (top ? -4 : -1) + (1 - skill) * 6 + (correlated ? 0 : (rnd() - 0.5) * 4);
      const cut = correlated ? 0.4 + skill * 0.55 + (rnd() - 0.5) * 0.1 : 0.3 + rnd() * 0.65;
      return golfer(`${prefix}${String(i).padStart(2, '0')}`, top, Number(strokes.toFixed(3)), Number(cut.toFixed(3)));
    });
  return { golfers: [...make('t', nTop, true), ...make('d', nDark, false)] };
}

/** Exhaustive 3+3 top-k (score asc, hash tiebreak) for comparison. */
function bruteForceSix(inputs: OptimizerInputs, k: number) {
  const top = inputs.golfers.filter(g => g.isTopTier);
  const dark = inputs.golfers.filter(g => !g.isTopTier);
  const tri = <T,>(a: T[]) => {
    const o: T[][] = [];
    for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++)
      for (let l = j + 1; l < a.length; l++) o.push([a[i], a[j], a[l]]);
    return o;
  };
  const all: Array<{ score: number; hash: string }> = [];
  for (const t of tri(top)) for (const d of tri(dark)) {
    const six = [...t, ...d];
    all.push({ score: __test.projectedSixScore(six), hash: computeFoursomeHash(six.map(g => g.id)) });
  }
  all.sort((a, b) => a.score - b.score || a.hash.localeCompare(b.hash));
  return all.slice(0, k);
}

describe('rankTop5Six — shape', () => {
  const out = rankTop5Six(seededField(7, 10, 16, true));
  it('returns 5 six-man teams, 3 top-tier + 3 dark horse, all distinct', () => {
    expect(out).toHaveLength(5);
    for (const f of out) {
      expect(f.teamSize).toBe(6);
      const ids = [f.topTier1Id, f.topTier2Id, f.topTier3Id, f.darkHorse1Id, f.darkHorse2Id, f.darkHorse3Id];
      expect(ids.every(Boolean)).toBe(true);
      expect(new Set(ids).size).toBe(6);
      expect([f.topTier1Id, f.topTier2Id, f.topTier3Id].every(id => id!.startsWith('t'))).toBe(true);
      expect([f.darkHorse1Id, f.darkHorse2Id, f.darkHorse3Id].every(id => id!.startsWith('d'))).toBe(true);
      expect(f.foursomeHash).toBe(computeFoursomeHash(ids as string[]));
      expect(f.foursomeExplanation).toMatch(/best-4-of-6/);
    }
    expect(new Set(out.map(f => f.foursomeHash)).size).toBe(5);
  });
  it('sorted best (lowest) first', () => {
    for (let i = 1; i < out.length; i++) {
      expect(out[i].projectedFantasyScore).toBeGreaterThanOrEqual(out[i - 1].projectedFantasyScore);
    }
  });
  it('is deterministic', () => {
    expect(rankTop5Six(seededField(7, 10, 16, true))).toEqual(out);
  });
  it('needs 3 of each tier', () => {
    expect(() => rankTop5Six({ golfers: seededField(1, 2, 6, true).golfers })).toThrow(/top-tier/);
    expect(() => rankTop5Six({ golfers: seededField(1, 6, 2, true).golfers })).toThrow(/dark-horse/);
  });
});

describe('rankTopKSix — pruned search matches brute force', () => {
  const cases: Array<[number, boolean]> = [[1, true], [2, true], [3, false], [4, false], [5, true], [6, false]];
  it.each(cases)('seed %i (correlated=%s): same top 5 scores and teams', (seed, correlated) => {
    const field = seededField(seed, 9, 14, correlated);
    const fast = rankTopKSix(field, 5).map(f => ({ score: f.projectedFantasyScore, hash: f.foursomeHash }));
    expect(fast).toEqual(bruteForceSix(field, 5));
  });
});

describe('scoring rule', () => {
  it('best 4 of 6 projected strokes + expected missed-cut penalty over all 6', () => {
    const six = [
      golfer('t1', true, -4, 1), golfer('t2', true, -3, 1), golfer('t3', true, 5, 0.5),
      golfer('d1', false, -2, 1), golfer('d2', false, -1, 1), golfer('d3', false, 9, 0.5),
    ];
    // best 4: -4 -3 -2 -1 = -10; penalty: 0.5 + 0.5 = 1
    expect(__test.projectedSixScore(six)).toBeCloseTo(-9, 10);
  });
});

describe('pruneDominated', () => {
  it('drops golfers beaten on both measures by >= slots + k - 1 others; keeps ties', () => {
    const gs = [
      ...Array.from({ length: 7 }, (_, i) => golfer(`good${i}`, false, -1 - i * 0.01, 0.9)),
      golfer('bad', false, 3, 0.2),           // dominated by all 7 → dropped (limit 3+5-1 = 7)
      golfer('twin', false, 3, 0.2),          // identical to 'bad' — neither dominates the other
    ];
    const kept = pruneDominated(gs, 3, 5).map(g => g.id);
    expect(kept).toContain('good0');
    expect(kept).not.toContain('bad');
    expect(kept).not.toContain('twin');       // also dominated by the 7 good ones
    const few = pruneDominated(gs.slice(5), 3, 5).map(g => g.id);   // only 2 good ones now
    expect(few).toEqual(['good5', 'good6', 'bad', 'twin']);
  });
});

describe('4-man path unchanged', () => {
  it('rankTop5 still returns 2+2 foursomes with teamSize 4 and no third slots', () => {
    const out = rankTop5(seededField(9, 6, 8, true));
    for (const f of out) {
      expect(f.teamSize).toBe(4);
      expect(f.topTier3Id).toBeNull();
      expect(f.darkHorse3Id).toBeNull();
      expect(f.foursomeExplanation).toMatch(/best-3 \+/);
    }
  });
});
