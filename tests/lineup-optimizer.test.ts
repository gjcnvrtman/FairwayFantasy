// Tests for src/lib/lineup-optimizer.ts — pure foursome enumeration
// + ranking. No DB. Uses small hand-built fields so expected output
// is enumerable; deterministic sort makes assertions trivial.

import { describe, it, expect } from 'vitest';
import {
  rankTop5, rankTopK, __test,
  type OptimizerGolfer,
  type OptimizerInputs,
} from '../src/lib/lineup-optimizer';
import type { GolferSubscores } from '../src/lib/course-fit';

// ── Fixture builders ────────────────────────────────────────

function sub(opts: Partial<GolferSubscores> = {}): GolferSubscores {
  return {
    courseFit:             50,
    recentForm:            50,
    longTerm:              50,
    courseHistory:         50,
    cutProbability:        70,
    upside:                50,
    composite:             55,
    missingInputs:         [],
    projectedStrokesToPar: 0,
    projectedCutProb:      0.7,
    explanation:           '',
    ...opts,
  };
}

function golfer(id: string, isTopTier: boolean,
                opts: Partial<GolferSubscores> = {}): OptimizerGolfer {
  return { id, isTopTier, subscores: sub(opts) };
}

/** 4 top-tier + 4 dark-horse. Top-tier are better golfers. */
function smallField(): OptimizerInputs {
  return {
    golfers: [
      // Top-tier: projected -3 to -1 vs par
      golfer('top-A', true,  { projectedStrokesToPar: -3, projectedCutProb: 0.95, upside: 60 }),
      golfer('top-B', true,  { projectedStrokesToPar: -2, projectedCutProb: 0.92, upside: 55 }),
      golfer('top-C', true,  { projectedStrokesToPar: -2, projectedCutProb: 0.90, upside: 65 }),
      golfer('top-D', true,  { projectedStrokesToPar: -1, projectedCutProb: 0.85, upside: 50 }),
      // Dark-horse: projected 0 to +3, lower cut probs
      golfer('dark-A', false, { projectedStrokesToPar: 0,  projectedCutProb: 0.75, upside: 75 }),
      golfer('dark-B', false, { projectedStrokesToPar: 1,  projectedCutProb: 0.70, upside: 80 }),
      golfer('dark-C', false, { projectedStrokesToPar: 2,  projectedCutProb: 0.65, upside: 60 }),
      golfer('dark-D', false, { projectedStrokesToPar: 3,  projectedCutProb: 0.55, upside: 50 }),
    ],
  };
}

// ── Legal-shape enforcement ────────────────────────────────

describe('rankTop5 — legal shape', () => {
  it('returns exactly 5 recommendations on a small field', () => {
    const out = rankTop5(smallField());
    expect(out).toHaveLength(5);
  });

  it('every foursome has exactly 2 top-tier + 2 dark-horse', () => {
    const field = smallField();
    const idIsTopTier = new Map<string, boolean>();
    for (const g of field.golfers) idIsTopTier.set(g.id, g.isTopTier);
    const out = rankTop5(field);
    for (const f of out) {
      expect(idIsTopTier.get(f.topTier1Id)).toBe(true);
      expect(idIsTopTier.get(f.topTier2Id)).toBe(true);
      expect(idIsTopTier.get(f.darkHorse1Id)).toBe(false);
      expect(idIsTopTier.get(f.darkHorse2Id)).toBe(false);
    }
  });

  it('throws when fewer than 2 top-tier golfers', () => {
    const bad: OptimizerInputs = {
      golfers: [
        golfer('top-A', true),
        golfer('dark-A', false), golfer('dark-B', false), golfer('dark-C', false),
      ],
    };
    expect(() => rankTop5(bad)).toThrow(/Need >=2 top-tier/);
  });

  it('throws when fewer than 2 dark-horse golfers', () => {
    const bad: OptimizerInputs = {
      golfers: [
        golfer('top-A', true), golfer('top-B', true), golfer('top-C', true),
        golfer('dark-A', false),
      ],
    };
    expect(() => rankTop5(bad)).toThrow(/Need >=2 dark-horse/);
  });
});

// ── Dedup invariant ────────────────────────────────────────

describe('rankTop5 — duplicate prevention', () => {
  it('no two recommendations have the same foursome_hash', () => {
    const out = rankTop5(smallField());
    const hashes = new Set(out.map(f => f.foursomeHash));
    expect(hashes.size).toBe(out.length);
  });

  it('foursome_hash matches src/lib/scoring.ts:computeFoursomeHash semantics (order-independent)', () => {
    const out = rankTop5(smallField());
    // Hash for slot order [A,B,C,D] must equal hash of the same 4 ids
    // in any order — computeFoursomeHash sorts before joining.
    for (const f of out) {
      const ids = [f.topTier1Id, f.topTier2Id, f.darkHorse1Id, f.darkHorse2Id];
      const expectedHash = [...ids].sort().join('|');
      expect(f.foursomeHash).toBe(expectedHash);
    }
  });
});

// ── Ranking — lower projected score wins ───────────────────

describe('rankTop5 — ordering', () => {
  it('output is sorted ascending by projectedFantasyScore (lower = better)', () => {
    const out = rankTop5(smallField());
    for (let i = 1; i < out.length; i++) {
      expect(out[i].projectedFantasyScore).toBeGreaterThanOrEqual(
        out[i - 1].projectedFantasyScore,
      );
    }
  });

  it('rank 1 foursome includes the two best top-tier golfers (top-A + top-B/C)', () => {
    // top-A is clearly best (-3); top-B and top-C tied at -2. The optimal
    // foursome should include top-A.
    const out = rankTop5(smallField());
    const idsInRank1 = [out[0].topTier1Id, out[0].topTier2Id];
    expect(idsInRank1).toContain('top-A');
  });

  it('rank 1 dark-horse half includes dark-A (best projected & best cut prob)', () => {
    const out = rankTop5(smallField());
    const idsInRank1 = [out[0].darkHorse1Id, out[0].darkHorse2Id];
    expect(idsInRank1).toContain('dark-A');
  });
});

// ── Determinism ────────────────────────────────────────────

describe('rankTop5 — determinism', () => {
  it('same inputs produce identical output ordering', () => {
    const a = rankTop5(smallField());
    const b = rankTop5(smallField());
    expect(a).toEqual(b);
  });

  it('shuffled inputs produce identical output ordering', () => {
    const original = smallField();
    const shuffled: OptimizerInputs = {
      golfers: [...original.golfers].reverse(),
    };
    const a = rankTop5(original);
    const b = rankTop5(shuffled);
    expect(a).toEqual(b);
  });
});

// ── Risk-level classification ──────────────────────────────

describe('risk-level classification', () => {
  it('tight upside cluster → conservative', () => {
    const four: OptimizerGolfer[] = [
      golfer('a', true,  { upside: 50 }),
      golfer('b', true,  { upside: 52 }),
      golfer('c', false, { upside: 49 }),
      golfer('d', false, { upside: 51 }),
    ];
    expect(__test.classifyRisk(four)).toBe('conservative');
  });

  it('wide upside spread → aggressive', () => {
    const four: OptimizerGolfer[] = [
      golfer('a', true,  { upside: 80 }),
      golfer('b', true,  { upside: 30 }),
      golfer('c', false, { upside: 90 }),
      golfer('d', false, { upside: 20 }),
    ];
    expect(__test.classifyRisk(four)).toBe('aggressive');
  });

  it('moderate spread → balanced', () => {
    const four: OptimizerGolfer[] = [
      golfer('a', true,  { upside: 60 }),
      golfer('b', true,  { upside: 50 }),
      golfer('c', false, { upside: 45 }),
      golfer('d', false, { upside: 70 }),
    ];
    expect(__test.classifyRisk(four)).toBe('balanced');
  });
});

// ── Confidence ─────────────────────────────────────────────

describe('confidence score', () => {
  it('is 1.0 when all 4 golfers have full inputs and similar composites', () => {
    const four: OptimizerGolfer[] = [
      golfer('a', true,  { composite: 55, missingInputs: [] }),
      golfer('b', true,  { composite: 56, missingInputs: [] }),
      golfer('c', false, { composite: 55, missingInputs: [] }),
      golfer('d', false, { composite: 54, missingInputs: [] }),
    ];
    expect(__test.confidence(four)).toBeGreaterThan(0.95);
  });

  it('drops with missing inputs', () => {
    const four: OptimizerGolfer[] = [
      golfer('a', true,  { composite: 55, missingInputs: ['sg_app', 'course_history', 'make_cut_prob'] }),
      golfer('b', true,  { composite: 55, missingInputs: ['sg_app', 'course_history'] }),
      golfer('c', false, { composite: 55, missingInputs: ['sg_app'] }),
      golfer('d', false, { composite: 55, missingInputs: [] }),
    ];
    expect(__test.confidence(four)).toBeLessThan(0.90);
  });

  it('drops with wide composite spread', () => {
    const four: OptimizerGolfer[] = [
      golfer('a', true,  { composite: 90 }),
      golfer('b', true,  { composite: 20 }),
      golfer('c', false, { composite: 80 }),
      golfer('d', false, { composite: 25 }),
    ];
    expect(__test.confidence(four)).toBeLessThan(0.75);
  });

  it('is clamped to [0, 1]', () => {
    const four: OptimizerGolfer[] = [
      golfer('a', true,  { composite: 99, missingInputs: ['a', 'b', 'c', 'd', 'e'] }),
      golfer('b', true,  { composite: 1,  missingInputs: ['a', 'b', 'c', 'd', 'e'] }),
      golfer('c', false, { composite: 99, missingInputs: ['a', 'b', 'c', 'd', 'e'] }),
      golfer('d', false, { composite: 1,  missingInputs: ['a', 'b', 'c', 'd', 'e'] }),
    ];
    const v = __test.confidence(four);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});

// ── Foursome score math ────────────────────────────────────

describe('projectedFantasyScore math', () => {
  it('is best-3-of-4 sum + expected missed-cut penalty', () => {
    const four: OptimizerGolfer[] = [
      golfer('a', true,  { projectedStrokesToPar: -3, projectedCutProb: 0.90 }),
      golfer('b', true,  { projectedStrokesToPar: -2, projectedCutProb: 0.80 }),
      golfer('c', false, { projectedStrokesToPar: 0,  projectedCutProb: 0.70 }),
      golfer('d', false, { projectedStrokesToPar: 5,  projectedCutProb: 0.60 }),
    ];
    // best 3 = -3 + -2 + 0 = -5
    // penalty = (1-0.9) + (1-0.8) + (1-0.7) + (1-0.6) = 1.0 strokes
    const expected = -5 + 1.0;
    expect(__test.projectedFantasyScore(four)).toBeCloseTo(expected, 3);
  });

  it('best-3-of-4 always drops the worst score', () => {
    expect(__test.bestThreeOfFour([0, 0, 0, 10])).toBe(0);
    expect(__test.bestThreeOfFour([-3, -2, -1, 5])).toBe(-6);
    expect(__test.bestThreeOfFour([10, 10, 10, 0])).toBe(20);  // worst kept = 10, drop = 10
  });
});

// ── Ownership ──────────────────────────────────────────────

describe('ownership computation', () => {
  it('is NULL when ownership map is omitted', () => {
    const out = rankTop5(smallField());
    expect(out[0].estimatedOwnershipPct).toBeNull();
  });

  it('averages golfer-level ownership when provided', () => {
    const ownership = new Map<string, number>([
      ['top-A', 0.40], ['top-B', 0.30], ['top-C', 0.10], ['top-D', 0.05],
      ['dark-A', 0.50], ['dark-B', 0.20], ['dark-C', 0.10], ['dark-D', 0.05],
    ]);
    const out = rankTop5({ ...smallField(), ownership });
    for (const f of out) {
      expect(f.estimatedOwnershipPct).not.toBeNull();
      expect(f.estimatedOwnershipPct).toBeGreaterThanOrEqual(0);
      expect(f.estimatedOwnershipPct).toBeLessThanOrEqual(100);
    }
  });
});

// ── Top-K generalization ───────────────────────────────────

describe('rankTopK', () => {
  it('rankTop5 == rankTopK(_, 5)', () => {
    const a = rankTop5(smallField());
    const b = rankTopK(smallField(), 5);
    expect(a).toEqual(b);
  });

  it('returns at most the requested K candidates', () => {
    expect(rankTopK(smallField(), 3)).toHaveLength(3);
    expect(rankTopK(smallField(), 1)).toHaveLength(1);
  });

  it('returns empty when K <= 0', () => {
    expect(rankTopK(smallField(), 0)).toEqual([]);
    expect(rankTopK(smallField(), -1)).toEqual([]);
  });
});

// ── Explanation + concerns ─────────────────────────────────

describe('explanation strings', () => {
  it('every foursome has a non-empty explanation', () => {
    const out = rankTop5(smallField());
    for (const f of out) {
      expect(f.foursomeExplanation.length).toBeGreaterThan(0);
      expect(f.foursomeExplanation).toMatch(/strokes vs par/);
    }
  });

  it('keyConcerns includes missing-data warning when 3+ fields missing across the four', () => {
    const field: OptimizerInputs = {
      golfers: [
        golfer('top-A', true,  { missingInputs: ['sg_app', 'course_history'] }),
        golfer('top-B', true,  { missingInputs: ['make_cut_prob'] }),
        golfer('top-C', true,  { missingInputs: [] }),
        golfer('top-D', true,  { missingInputs: [] }),
        golfer('dark-A', false, { missingInputs: ['sg_total'] }),
        golfer('dark-B', false, { missingInputs: [] }),
        golfer('dark-C', false, { missingInputs: [] }),
        golfer('dark-D', false, { missingInputs: [] }),
      ],
    };
    const out = rankTop5(field);
    const top = out[0];
    // Whichever 4 are picked, at least one should hit the warning depending
    // on which golfers were selected. The recommendation that includes
    // top-A + top-B will accumulate >= 3 distinct missing fields.
    const allConcerns = out.flatMap(f => f.keyConcerns).join('|');
    expect(allConcerns).toMatch(/partial data/);
  });
});
