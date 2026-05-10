// ============================================================
// SCORING RULES ENGINE
// Applies all 5 custom fantasy rules
// ============================================================

import type { Pick, Score, FantasyResult } from '@/types';
import { parseESPNScore, mapESPNStatus } from './espn';

// ── Rule Application ─────────────────────────────────────────
/**
 * Apply all fantasy rules to a raw ESPN competitor entry.
 * Returns the adjusted fantasy score for this golfer.
 *
 * Rules:
 *  1. Missed cut  → score = cut_score + 1
 *  2. Made cut    → final score capped at cut_score (can't score worse)
 *  3. Active      → use live score as-is
 *  4. Withdrawn   → no score, flag for replacement
 */
export function applyFantasyRules(params: {
  scoreToParRaw: string;   // ESPN string like "-4", "E", "+2"
  espnStatus: string;      // ESPN status string
  cutScore: number | null; // Tournament cut line (strokes to par)
}): {
  fantasyScore: number | null;
  status: Score['status'];
} {
  const { scoreToParRaw, espnStatus, cutScore } = params;
  const status = mapESPNStatus(espnStatus);
  const rawScore = parseESPNScore(scoreToParRaw);

  switch (status) {
    case 'missed_cut':
      // Rule: missed cut = cut score + 1 stroke penalty
      return {
        fantasyScore: cutScore !== null ? cutScore + 1 : rawScore + 1,
        status: 'missed_cut',
      };

    case 'active':
    case 'complete':
      if (cutScore !== null) {
        // Rule: made cut = score capped at cut score (can't be worse than cut)
        return {
          fantasyScore: Math.min(rawScore, cutScore),
          status,
        };
      }
      return { fantasyScore: rawScore, status };

    case 'withdrawn':
    case 'disqualified':
      // No score — flag for replacement window
      return { fantasyScore: null, status };

    default:
      return { fantasyScore: rawScore, status: 'active' };
  }
}

// ── Top-3 Calculation ────────────────────────────────────────
/**
 * Given 4 golfer scores, return the best 3 and their sum.
 * Rule: only top 3 of your 4 golfers count toward final score.
 * Lower score = better (it's golf).
 */
export function calculateTop3(scores: (number | null)[]): {
  countingIndices: number[];  // Which slots are counting (0-indexed)
  total: number | null;
} {
  const scored = scores
    .map((s, i) => ({ score: s, index: i }))
    .filter(x => x.score !== null) as Array<{ score: number; index: number }>;

  if (scored.length === 0) return { countingIndices: [], total: null };

  // Sort ascending (lower = better in golf)
  scored.sort((a, b) => a.score - b.score);

  const top3 = scored.slice(0, 3);
  const total = top3.reduce((sum, x) => sum + x.score, 0);

  return {
    countingIndices: top3.map(x => x.index),
    total,
  };
}

// ── Full League Result Computation ───────────────────────────
/**
 * Compute fantasy results for all picks in a league for a tournament.
 * Called after each score sync.
 */
export function computeLeagueResults(
  picks: Pick[],
  scoreMap: Map<string, Score>, // keyed by golfer UUID
): Omit<FantasyResult, 'id' | 'updated_at'>[] {
  const results = picks.map(pick => {
    const golferIds = [
      pick.golfer_1_id,
      pick.golfer_2_id,
      pick.golfer_3_id,
      pick.golfer_4_id,
    ];

    const scores = golferIds.map(id => {
      if (!id) return null;
      // If golfer was replaced, use replacement's score
      const score = scoreMap.get(id);
      if (!score) return null;
      if (score.was_replaced && score.replaced_by_golfer_id) {
        return scoreMap.get(score.replaced_by_golfer_id)?.fantasy_score ?? null;
      }
      return score.fantasy_score;
    });

    const { countingIndices, total } = calculateTop3(scores);

    return {
      league_id:       pick.league_id,
      tournament_id:   pick.tournament_id,
      user_id:         pick.user_id,
      golfer_1_score:  scores[0],
      golfer_2_score:  scores[1],
      golfer_3_score:  scores[2],
      golfer_4_score:  scores[3],
      counting_golfers: countingIndices.map(i => i + 1), // 1-indexed for display
      total_score:     total,
      rank:            null, // assigned after sorting all results
    };
  });

  // Assign ranks (lower total = better rank)
  const withScores = results.filter(r => r.total_score !== null);
  withScores.sort((a, b) => (a.total_score ?? 0) - (b.total_score ?? 0));

  let rank = 1;
  for (let i = 0; i < withScores.length; i++) {
    if (i > 0 && withScores[i].total_score !== withScores[i - 1].total_score) {
      rank = i + 1; // Adjust for ties
    }
    withScores[i].rank = rank;
  }

  return results;
}

// ── Pick Validation ──────────────────────────────────────────
/**
 * Helper: is this golfer eligible for a top-tier slot?
 *
 * Top tier means OWGR rank 1–24. The schema computes
 * ``is_dark_horse`` as ``GENERATED ALWAYS AS (owgr_rank > 24) STORED``,
 * which evaluates to NULL when ``owgr_rank`` is NULL — and JS treats
 * that null as falsy, so the previous ``if (golfer.is_dark_horse)``
 * incorrectly let UNRANKED golfers slide into top-tier slots.
 *
 * Source-of-truth alignment with ``data/datagolf.ts:isDarkHorse``
 * which says "Unranked counts as dark horse" → unranked is NOT
 * top-tier eligible.
 */
function isTopTierEligible(golfer: { is_dark_horse: boolean | null; owgr_rank: number | null }): boolean {
  // Only golfers with is_dark_horse === false (i.e., explicitly top tier
  // per the schema's owgr_rank > 24 generated column) qualify.
  return golfer.is_dark_horse === false;
}

/**
 * Helper: is this golfer eligible for a dark-horse slot?
 * Unranked (is_dark_horse === null) is accepted as dark horse —
 * matches ``data/datagolf.ts:isDarkHorse(null) === true``.
 */
function isDarkHorseEligible(golfer: { is_dark_horse: boolean | null }): boolean {
  return golfer.is_dark_horse === true || golfer.is_dark_horse === null;
}

/**
 * Validate a pick submission against all rules.
 * Returns array of error messages (empty = valid).
 *
 * Note that ``existingPicks`` is the list of OTHER players' picks in
 * the same league + tournament. The caller is responsible for
 * filtering out the current user's own previous pick so editing
 * doesn't trigger the no-copycats rule against your own old foursome.
 */
export function validatePick(params: {
  golferIds: (string | null)[];
  golfers: Array<{ id: string; owgr_rank: number | null; is_dark_horse: boolean | null; name: string }>;
  existingPicks: Array<{ golfer_1_id: string; golfer_2_id: string; golfer_3_id: string; golfer_4_id: string }>;
}): string[] {
  const { golferIds, golfers, existingPicks } = params;
  const errors: string[] = [];

  const [g1, g2, g3, g4] = golferIds;

  // ── All 4 must be selected ──
  if (!g1 || !g2 || !g3 || !g4) {
    errors.push('You must select all 4 golfers.');
    return errors;
  }

  // ── No duplicates within pick ──
  const unique = new Set([g1, g2, g3, g4]);
  if (unique.size < 4) {
    errors.push('You cannot pick the same golfer more than once.');
  }

  // ── Slots 1-2 must be top tier (OWGR rank 1-24) ──
  const topTierSlots = [g1, g2];
  topTierSlots.forEach((id, i) => {
    const golfer = golfers.find(g => g.id === id);
    if (!golfer) return;
    if (!isTopTierEligible(golfer)) {
      const rankNote = golfer.owgr_rank
        ? `ranked ${golfer.owgr_rank}`
        : 'unranked';
      errors.push(
        `Slot ${i + 1} must be a top-tier golfer (ranked 1–24). ${golfer.name} is ${rankNote}.`
      );
    }
  });

  // ── Slots 3-4 must be dark horses (OWGR rank 25+ or unranked) ──
  const darkHorseSlots = [g3, g4];
  darkHorseSlots.forEach((id, i) => {
    const golfer = golfers.find(g => g.id === id);
    if (!golfer) return;
    if (!isDarkHorseEligible(golfer)) {
      errors.push(
        `Slot ${i + 3} must be a dark horse (ranked 25+ or unranked). ${golfer.name} is ranked ${golfer.owgr_rank}.`
      );
    }
  });

  // ── No two players in the league can pick the identical set of 4 ──
  const newSet = new Set([g1, g2, g3, g4]);
  for (const existing of existingPicks) {
    const existingSet = new Set([
      existing.golfer_1_id,
      existing.golfer_2_id,
      existing.golfer_3_id,
      existing.golfer_4_id,
    ]);
    if (
      newSet.size === existingSet.size &&
      [...newSet].every(id => existingSet.has(id))
    ) {
      errors.push(
        'Another player in your league has already picked this exact ' +
        'combination of 4 golfers. Please choose a different lineup.'
      );
    }
  }

  return errors;
}

// ── Replacement Validation ───────────────────────────────────
/**
 * Check if a replacement golfer is eligible.
 * Rule: replacement must not have teed off yet.
 */
export function isReplacementEligible(golfer: {
  status: string;
  teed_off: boolean;
}): boolean {
  return !golfer.teed_off && golfer.status === 'active';
}

// ── Score Display Helpers ────────────────────────────────────
export function formatScore(score: number | null): string {
  if (score === null) return '—';
  if (score === 0) return 'E';
  return score > 0 ? `+${score}` : `${score}`;
}

export function scoreColorClass(score: number | null): string {
  if (score === null) return 'text-gray-400';
  if (score < 0)  return 'text-red-500';
  if (score === 0) return 'text-gray-900';
  return 'text-blue-600';
}
