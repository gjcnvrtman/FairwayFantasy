// ============================================================
// LINEUP OPTIMIZER — pure foursome enumeration + ranking.
//
// Given a scored field (one row per golfer with composite + cut prob +
// projected strokes), generate every LEGAL foursome (2 top-tier +
// 2 dark-horse) and return the top 5 by projected fantasy score.
//
// "Legal" matches the FairwayFantasy lineup rule from
// src/lib/scoring.ts:
//   - exactly 4 golfers
//   - slots 1-2 from the top-tier set (24 highest OWGR-ranked IN this
//     tournament's field, per src/lib/field-tiers.ts)
//   - slots 3-4 from the dark-horse set (everyone else)
//   - no duplicate foursome SETS within the run (dedup by hash from
//     src/lib/scoring.ts:computeFoursomeHash)
//
// "Top 5 by projected fantasy score" uses the league scoring rule —
// the team total is the sum of the BEST 3 of 4 individual projected
// strokes-to-par, plus an expected missed-cut penalty over all 4
// golfers. Lower = better. See projectedFantasyScore() below.
//
// Determinism: golfers are sorted by id before pair enumeration, so a
// fixed input always produces the identical ordered top-5 output (per
// the Phase 2 spec note "deterministic unless randomness explicitly
// enabled"). The Monte-Carlo "best of 4 in distribution" approximation
// is deliberately deferred to v2.
//
// Pure — no I/O, no clock reads.
// ============================================================

import { computeFoursomeHash, MISSED_CUT_PENALTY_STROKES } from './scoring';
import type { GolferSubscores } from './course-fit';

// ── Input / output types ────────────────────────────────────

export interface OptimizerGolfer {
  /** UUID for FK back to golfers.id. */
  id: string;
  isTopTier: boolean;
  /** From course-fit.ts:scoreGolfer. */
  subscores: GolferSubscores;
}

export interface OptimizerInputs {
  golfers: OptimizerGolfer[];
  /** Optional: golfer_id → ownership 0..1 across submitted picks in
   *  this league for this tournament. NULL → ownership reported as null. */
  ownership?: Map<string, number>;
}

export interface FoursomeCandidate {
  topTier1Id: string;
  topTier2Id: string;
  darkHorse1Id: string;
  darkHorse2Id: string;
  /** Order-independent set hash, computed via computeFoursomeHash. */
  foursomeHash: string;
  /** Lower = better. Best-3 sum + expected missed-cut penalty. */
  projectedFantasyScore: number;
  confidenceScore: number;        // 0..1
  riskLevel: 'conservative' | 'balanced' | 'aggressive';
  estimatedOwnershipPct: number | null;
  keyStrengths: string[];
  keyConcerns: string[];
  foursomeExplanation: string;
}

// ── Constants — tuned to the spec scoring rule ──────────────

const TOP_K = 5;

/** Approximate "expected best 3 of 4" using deterministic sort.
 *  The user-spec is "deterministic unless randomness explicitly
 *  enabled" — Monte Carlo over per-golfer projected distributions
 *  is the obvious v2 upgrade, but we stay deterministic for v1. */
function bestThreeOfFour(values: [number, number, number, number]): number {
  const sorted = [...values].sort((a, b) => a - b);   // ascending = lower (better) first
  return sorted[0] + sorted[1] + sorted[2];
}

/** Continuous expected-missed-cut penalty across a 4-golfer set.
 *  Each golfer contributes `(1 - cutProb) × MISSED_CUT_PENALTY_STROKES`
 *  — the expectation under the assumption that miss-the-cut events are
 *  independent. Matches the spec's "(missed-cut count × 1)" rule in
 *  expectation. */
function expectedMissedCutPenalty(cutProbs: number[]): number {
  return cutProbs.reduce(
    (acc, p) => acc + (1 - p) * MISSED_CUT_PENALTY_STROKES,
    0,
  );
}

// ── Risk classification ─────────────────────────────────────

/**
 * Risk level reflects how MUCH variance the foursome carries via its
 * `upside` subscore dispersion.
 *
 *   - upside-stdev ≤ 8  → conservative (tight cluster of safe picks)
 *   - upside-stdev ≤ 18 → balanced
 *   - else              → aggressive
 *
 * Thresholds picked from the 0..100 subscore range — most foursomes
 * land in the balanced bucket; the extremes are the interesting tails.
 */
function classifyRisk(four: OptimizerGolfer[]): 'conservative' | 'balanced' | 'aggressive' {
  const ups = four.map(g => g.subscores.upside);
  const mean = ups.reduce((a, b) => a + b, 0) / ups.length;
  const variance = ups.reduce((a, v) => a + (v - mean) ** 2, 0) / ups.length;
  const sd = Math.sqrt(variance);
  if (sd <= 8) return 'conservative';
  if (sd <= 18) return 'balanced';
  return 'aggressive';
}

// ── Confidence ──────────────────────────────────────────────

/**
 * Composite of two penalties:
 *   - average per-golfer missing-input count (more missing → lower)
 *   - composite-subscore stdev across the 4 (more dispersion → lower)
 * Mapped to [0, 1] with reasonable saturation.
 */
function confidence(four: OptimizerGolfer[]): number {
  const avgMissing = four.reduce((a, g) => a + g.subscores.missingInputs.length, 0) / 4;
  const composites = four.map(g => g.subscores.composite);
  const mean = composites.reduce((a, b) => a + b, 0) / 4;
  const sd = Math.sqrt(composites.reduce((a, v) => a + (v - mean) ** 2, 0) / 4);

  // missing>=3 → -0.30, sd>=20 → -0.30; saturate.
  const missingPenalty = Math.min(0.30, avgMissing * 0.10);
  const sdPenalty = Math.min(0.30, sd * 0.015);
  return Math.max(0, Math.min(1, 1 - missingPenalty - sdPenalty));
}

// ── Foursome score (lower = better, golf) ───────────────────

function projectedFantasyScore(four: OptimizerGolfer[]): number {
  const strokes = four.map(g => g.subscores.projectedStrokesToPar) as
    [number, number, number, number];
  const cutProbs = four.map(g => g.subscores.projectedCutProb);
  return bestThreeOfFour(strokes) + expectedMissedCutPenalty(cutProbs);
}

// ── Pair enumeration ────────────────────────────────────────

function pairs<T>(items: T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      out.push([items[i], items[j]]);
    }
  }
  return out;
}

// ── Explanation builders ────────────────────────────────────

function buildKeyStrengths(four: OptimizerGolfer[]): string[] {
  const out: string[] = [];
  const cfMean = four.reduce((a, g) => a + g.subscores.courseFit, 0) / 4;
  const cpMean = four.reduce((a, g) => a + g.subscores.cutProbability, 0) / 4;
  const rfMean = four.reduce((a, g) => a + g.subscores.recentForm, 0) / 4;
  const upMax = Math.max(...four.map(g => g.subscores.upside));
  if (cfMean >= 70) out.push('Strong overall course fit');
  if (cpMean >= 85) out.push('High combined make-cut probability');
  if (rfMean >= 75) out.push('All four golfers in hot recent form');
  if (upMax >= 80) out.push('High-upside ceiling on at least one dark horse');
  return out;
}

function buildKeyConcerns(four: OptimizerGolfer[]): string[] {
  const out: string[] = [];
  const cpMin = Math.min(...four.map(g => g.subscores.cutProbability));
  const missing = new Set<string>();
  for (const g of four) for (const m of g.subscores.missingInputs) missing.add(m);
  if (cpMin <= 55) out.push('Weak cut-make probability on at least one golfer');
  if (missing.size >= 3) out.push(`Predictions running on partial data (${missing.size} missing fields)`);
  return out;
}

function buildFoursomeExplanation(
  four: OptimizerGolfer[],
  score: number,
  risk: 'conservative' | 'balanced' | 'aggressive',
): string {
  const strokes = score.toFixed(1);
  return `Projected best-3 + cut penalty: ${strokes} strokes vs par. Risk profile: ${risk}.`;
}

// ── Main entry ──────────────────────────────────────────────

/**
 * Generate every legal foursome (2 top-tier × 2 dark-horse pairs),
 * score them, and return the top-K by projected fantasy score with
 * duplicates removed (one foursome set per rank).
 */
export function rankTop5(inputs: OptimizerInputs): FoursomeCandidate[] {
  return rankTopK(inputs, TOP_K);
}

/**
 * Generalized top-K. Exposed for tests that want to inspect more
 * than 5 candidates. The default rankTop5 is what production uses.
 */
export function rankTopK(inputs: OptimizerInputs, k: number): FoursomeCandidate[] {
  if (k <= 0) return [];

  // Sort golfers by id for deterministic pair order. Without this two
  // identical inputs could surface foursomes in different orders when
  // scores tie.
  const sortedById = [...inputs.golfers].sort((a, b) => a.id.localeCompare(b.id));
  const topTier = sortedById.filter(g => g.isTopTier);
  const darkHorse = sortedById.filter(g => !g.isTopTier);

  if (topTier.length < 2) {
    throw new Error(`Need >=2 top-tier golfers, got ${topTier.length}`);
  }
  if (darkHorse.length < 2) {
    throw new Error(`Need >=2 dark-horse golfers, got ${darkHorse.length}`);
  }

  const topPairs = pairs(topTier);
  const darkPairs = pairs(darkHorse);

  // Build raw candidate list. Use a Map keyed by hash to dedup as we go
  // — without dedup, the same SET can theoretically appear twice from
  // different pair orderings (it can't with our enforcement above, but
  // belt-and-braces).
  const byHash = new Map<string, FoursomeCandidate>();

  for (const [t1, t2] of topPairs) {
    for (const [d1, d2] of darkPairs) {
      const four: OptimizerGolfer[] = [t1, t2, d1, d2];
      const hash = computeFoursomeHash([t1.id, t2.id, d1.id, d2.id]);
      if (byHash.has(hash)) continue;

      const score = projectedFantasyScore(four);
      const risk = classifyRisk(four);
      const conf = confidence(four);

      // Ownership estimated as the AVERAGE of per-golfer ownership
      // across the foursome — gives a rough "how chalky is this pick".
      let ownership: number | null = null;
      if (inputs.ownership && inputs.ownership.size > 0) {
        const vals = four.map(g => inputs.ownership!.get(g.id) ?? 0);
        ownership = (vals.reduce((a, b) => a + b, 0) / 4) * 100;
      }

      byHash.set(hash, {
        topTier1Id: t1.id,
        topTier2Id: t2.id,
        darkHorse1Id: d1.id,
        darkHorse2Id: d2.id,
        foursomeHash: hash,
        projectedFantasyScore: score,
        confidenceScore: conf,
        riskLevel: risk,
        estimatedOwnershipPct: ownership,
        keyStrengths: buildKeyStrengths(four),
        keyConcerns: buildKeyConcerns(four),
        foursomeExplanation: buildFoursomeExplanation(four, score, risk),
      });
    }
  }

  // Sort ascending (lower projected score = better). Tiebreak by hash
  // for full determinism.
  const all = Array.from(byHash.values()).sort((a, b) => {
    const d = a.projectedFantasyScore - b.projectedFantasyScore;
    if (d !== 0) return d;
    return a.foursomeHash.localeCompare(b.foursomeHash);
  });

  return all.slice(0, k);
}

// ── Public helpers exposed for tests ────────────────────────
export const __test = {
  bestThreeOfFour,
  expectedMissedCutPenalty,
  classifyRisk,
  confidence,
  projectedFantasyScore,
  pairs,
};
