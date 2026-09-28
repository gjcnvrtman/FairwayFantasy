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
// 6-man majors (migration 026/029): rankTop5Six builds 3 top-tier +
// 3 dark-horse teams scored on the best 4 of 6. Exhaustive search is
// ~700M teams, so the field is first pruned by dominance (see
// pruneDominated) — exact for the top 5, including their order. The
// 4-man search uses the same pruning (perf, 2026-09-28).
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
  /** 4 = 2+2 best 3 count; 6 = 3+3 best 4 count (6-man majors). */
  teamSize: 4 | 6;
  topTier1Id: string;
  topTier2Id: string;
  darkHorse1Id: string;
  darkHorse2Id: string;
  /** 6-man teams only; null for foursomes. */
  topTier3Id: string | null;
  darkHorse3Id: string | null;
  /** Order-independent set hash, computed via computeFoursomeHash. */
  foursomeHash: string;
  /** Lower = better. Best-N sum + expected missed-cut penalty. */
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
  return bestNOf(values, 3);
}

/** Sum of the `n` lowest (best) values. */
function bestNOf(values: number[], n: number): number {
  const sorted = [...values].sort((a, b) => a - b);   // ascending = lower (better) first
  let sum = 0;
  for (let i = 0; i < Math.min(n, sorted.length); i++) sum += sorted[i];
  return sum;
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
  const n = four.length;
  const avgMissing = four.reduce((a, g) => a + g.subscores.missingInputs.length, 0) / n;
  const composites = four.map(g => g.subscores.composite);
  const mean = composites.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(composites.reduce((a, v) => a + (v - mean) ** 2, 0) / n);

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

/** 6-man: best 4 of 6 projected strokes + expected MC penalty over all 6. */
function projectedSixScore(six: OptimizerGolfer[]): number {
  return bestNOf(six.map(g => g.subscores.projectedStrokesToPar), 4)
       + expectedMissedCutPenalty(six.map(g => g.subscores.projectedCutProb));
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
  const n = four.length;
  const cfMean = four.reduce((a, g) => a + g.subscores.courseFit, 0) / n;
  const cpMean = four.reduce((a, g) => a + g.subscores.cutProbability, 0) / n;
  const rfMean = four.reduce((a, g) => a + g.subscores.recentForm, 0) / n;
  const upMax = Math.max(...four.map(g => g.subscores.upside));
  if (cfMean >= 70) out.push('Strong overall course fit');
  if (cpMean >= 85) out.push('High combined make-cut probability');
  if (rfMean >= 75) out.push(`All ${four.length === 6 ? 'six' : 'four'} golfers in hot recent form`);
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
  const best = four.length === 6 ? 'best-4-of-6' : 'best-3';
  return `Projected ${best} + cut penalty: ${strokes} strokes vs par. Risk profile: ${risk}.`;
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

  // Perf (2026-09-28): prune golfers that can't reach the top k (see
  // pruneDominated — exact, including tie order), score every remaining
  // foursome, keep the best k, and only build strengths / concerns /
  // explanation for those. Was ~5–6 s per call on a real field because
  // all ~2.3M foursomes got full objects; output is byte-identical
  // (tests/lineup-optimizer-perf.test.ts checks it against the old
  // exhaustive algorithm).
  const topPairs = pairs(pruneDominated(topTier, 2, k));
  const darkPairs = pairs(pruneDominated(darkHorse, 2, k));

  // Top k by (score asc, hash asc) — the same total order the old
  // sort-everything version used.
  const kept: Array<{ four: OptimizerGolfer[]; score: number; hash: string }> = [];
  const before = (s: number, h: string, o: { score: number; hash: string }) =>
    s < o.score || (s === o.score && h.localeCompare(o.hash) < 0);
  for (const [t1, t2] of topPairs) {
    for (const [d1, d2] of darkPairs) {
      const four: OptimizerGolfer[] = [t1, t2, d1, d2];
      const score = projectedFantasyScore(four);
      if (kept.length >= k && score > kept[kept.length - 1].score) continue;
      const hash = computeFoursomeHash([t1.id, t2.id, d1.id, d2.id]);
      if (kept.length >= k && !before(score, hash, kept[kept.length - 1])) continue;
      let i = kept.length;
      while (i > 0 && before(score, hash, kept[i - 1])) i--;
      kept.splice(i, 0, { four, score, hash });
      if (kept.length > k) kept.pop();
    }
  }

  return kept.map(({ four, score, hash }) => {
    const [t1, t2, d1, d2] = four;
    const risk = classifyRisk(four);
    const conf = confidence(four);

    // Ownership estimated as the AVERAGE of per-golfer ownership
    // across the foursome — gives a rough "how chalky is this pick".
    let ownership: number | null = null;
    if (inputs.ownership && inputs.ownership.size > 0) {
      const vals = four.map(g => inputs.ownership!.get(g.id) ?? 0);
      ownership = (vals.reduce((a, b) => a + b, 0) / 4) * 100;
    }

    return {
      teamSize: 4 as const,
      topTier1Id: t1.id,
      topTier2Id: t2.id,
      darkHorse1Id: d1.id,
      darkHorse2Id: d2.id,
      topTier3Id: null,
      darkHorse3Id: null,
      foursomeHash: hash,
      projectedFantasyScore: score,
      confidenceScore: conf,
      riskLevel: risk,
      estimatedOwnershipPct: ownership,
      keyStrengths: buildKeyStrengths(four),
      keyConcerns: buildKeyConcerns(four),
      foursomeExplanation: buildFoursomeExplanation(four, score, risk),
    };
  });
}

// ── 6-man majors: 3 top-tier + 3 dark-horse, best 4 of 6 ─────

/** Safety cap on 3+3 teams scored after pruning. Real fields prune to
 *  ~10–16 golfers per tier (≈75k teams, <50 ms); the cap only bites on
 *  a pathological field, where it falls back to the best golfers by
 *  individual value and logs that the result is approximate. */
export const MAX_SIX_TEAMS = 3_000_000;

/**
 * Drop golfers who can't appear in the top-k teams (4- and 6-man).
 *
 * A team's projected score (best N strokes + expected missed-cut
 * penalty) only depends on each golfer's projected strokes (lower is
 * better) and cut probability (higher is better). Say d dominates g
 * when d's cut probability is STRICTLY higher and its strokes are no
 * worse: swapping g → d then makes any team STRICTLY better (the
 * penalty term strictly drops, the best-N sum can't rise). So a golfer
 * dominated by ≥ slots + k − 1 others is dropped: any team containing
 * it has ≥ k distinct swaps that rank strictly ahead of it (at most
 * slots − 1 of those dominators are already in the team). Because
 * "strictly ahead" never depends on the hash tiebreak, the top k —
 * including their order — is exactly what an exhaustive search gives.
 */
export function pruneDominated(golfers: OptimizerGolfer[], slots: number, k: number): OptimizerGolfer[] {
  const limit = slots + k - 1;
  return golfers.filter(g => {
    const gs = g.subscores.projectedStrokesToPar, gp = g.subscores.projectedCutProb;
    let dominators = 0;
    for (const o of golfers) {
      if (o === g) continue;
      if (o.subscores.projectedCutProb > gp && o.subscores.projectedStrokesToPar <= gs) {
        if (++dominators >= limit) return false;
      }
    }
    return true;
  });
}

function triples<T>(items: T[]): [T, T, T][] {
  const out: [T, T, T][] = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      for (let l = j + 1; l < items.length; l++) out.push([items[i], items[j], items[l]]);
  return out;
}

const choose3 = (n: number) => (n * (n - 1) * (n - 2)) / 6;

/** Individual value used only for the pathological-field fallback. */
const soloValue = (g: OptimizerGolfer) =>
  g.subscores.projectedStrokesToPar + (1 - g.subscores.projectedCutProb) * MISSED_CUT_PENALTY_STROKES;

/** Top 5 six-man teams (3 top-tier + 3 dark-horse, best 4 of 6 count). */
export function rankTop5Six(inputs: OptimizerInputs): FoursomeCandidate[] {
  return rankTopKSix(inputs, TOP_K);
}

export function rankTopKSix(inputs: OptimizerInputs, k: number): FoursomeCandidate[] {
  if (k <= 0) return [];
  const sortedById = [...inputs.golfers].sort((a, b) => a.id.localeCompare(b.id));
  const allTop  = sortedById.filter(g => g.isTopTier);
  const allDark = sortedById.filter(g => !g.isTopTier);
  if (allTop.length < 3)  throw new Error(`Need >=3 top-tier golfers, got ${allTop.length}`);
  if (allDark.length < 3) throw new Error(`Need >=3 dark-horse golfers, got ${allDark.length}`);

  let top  = pruneDominated(allTop, 3, k);
  let dark = pruneDominated(allDark, 3, k);
  if (choose3(top.length) * choose3(dark.length) > MAX_SIX_TEAMS) {
    const byValue = (a: OptimizerGolfer, b: OptimizerGolfer) =>
      soloValue(a) - soloValue(b) || a.id.localeCompare(b.id);
    top = [...top].sort(byValue);
    dark = [...dark].sort(byValue);
    while (choose3(top.length) * choose3(dark.length) > MAX_SIX_TEAMS) {
      if (choose3(dark.length) >= choose3(top.length) && dark.length > 3) dark = dark.slice(0, -1);
      else top = top.slice(0, -1);
    }
    top.sort((a, b) => a.id.localeCompare(b.id));
    dark.sort((a, b) => a.id.localeCompare(b.id));
    // eslint-disable-next-line no-console
    console.warn(`[lineup-optimizer] 6-man search capped at ${top.length}+${dark.length} golfers — results approximate`);
  }

  // Score every pruned team; keep the best k (lower = better, hash tiebreak).
  const topTriples = triples(top), darkTriples = triples(dark);
  const kept: Array<{ six: OptimizerGolfer[]; score: number; hash: string }> = [];
  for (const t of topTriples) {
    for (const d of darkTriples) {
      const six = [...t, ...d];
      const score = projectedSixScore(six);
      const worst = kept[kept.length - 1];
      if (kept.length >= k && score > worst.score) continue;
      const hash = computeFoursomeHash(six.map(g => g.id));
      if (kept.length >= k && score === worst.score && hash >= worst.hash) continue;
      kept.push({ six, score, hash });
      kept.sort((a, b) => a.score - b.score || a.hash.localeCompare(b.hash));
      if (kept.length > k) kept.pop();
    }
  }

  return kept.map(({ six, score, hash }) => {
    const risk = classifyRisk(six);
    let ownership: number | null = null;
    if (inputs.ownership && inputs.ownership.size > 0) {
      const vals = six.map(g => inputs.ownership!.get(g.id) ?? 0);
      ownership = (vals.reduce((a, b) => a + b, 0) / six.length) * 100;
    }
    return {
      teamSize: 6 as const,
      topTier1Id: six[0].id, topTier2Id: six[1].id, topTier3Id: six[2].id,
      darkHorse1Id: six[3].id, darkHorse2Id: six[4].id, darkHorse3Id: six[5].id,
      foursomeHash: hash,
      projectedFantasyScore: score,
      confidenceScore: confidence(six),
      riskLevel: risk,
      estimatedOwnershipPct: ownership,
      keyStrengths: buildKeyStrengths(six),
      keyConcerns: buildKeyConcerns(six),
      foursomeExplanation: buildFoursomeExplanation(six, score, risk),
    };
  });
}

// ── Public helpers exposed for tests ────────────────────────
export const __test = {
  bestThreeOfFour,
  bestNOf,
  expectedMissedCutPenalty,
  classifyRisk,
  confidence,
  projectedFantasyScore,
  projectedSixScore,
  pairs,
};
