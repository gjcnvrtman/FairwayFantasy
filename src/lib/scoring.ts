// ============================================================
// SCORING RULES ENGINE
// Applies all 5 custom fantasy rules
// ============================================================
//
// Rules (canonical, in plain English):
//   1. PICK SHAPE — every entry is exactly 4 golfers:
//        slots 1–2 = "top tier"  (OWGR rank 1..24)
//        slots 3–4 = "dark horse" (OWGR rank 25+ OR unranked)
//   2. NO COPYCATS — no two players in the same league + tournament
//      may submit the identical *set* of 4 golfers (slot order
//      doesn't matter; it's a set comparison).
//   3. SCORING — for each golfer:
//        a. MISSED CUT  → score = cut_line + MISSED_CUT_PENALTY_STROKES
//        b. MADE CUT    → final score capped at cut_line (can't be worse)
//        c. ACTIVE      → live score as-is (no cap during live play)
//        d. WD / DQ     → no score; eligible for replacement
//   4. TOP 3 OF 4 — only your best 3 of 4 golfer scores count toward
//      your total. Lower = better (it's golf).
//   5. REPLACEMENT — if a golfer withdraws or is DQ'd before teeing
//      off, you may swap them out. Replacement must not have teed off.
//
// All functions in this file are intended to be PURE — no I/O, no
// reads from the DB, no clock dependencies. Callers (sync-scores
// route, picks page, demo page) wire them up to real data.
//
// Bug references like "#5.1" point to TODO.md.
// ============================================================

import type { Pick, Score, FantasyResult } from '@/types';
import { parseESPNScore, mapESPNStatus } from './espn';

// ── Named constants ──────────────────────────────────────────
/** Strokes added to the cut line to compute a missed-cut fantasy score. */
export const MISSED_CUT_PENALTY_STROKES = 1;

/**
 * Fallback fantasy score used when ESPN reports a golfer as missed-cut
 * but we don't yet have a cut line value (rare race window during
 * sync, or a tournament with no cut-line data). A clearly losing
 * number — chosen so any realistic cut + 1 will beat it. Bug #5.2.
 */
export const MISSED_CUT_FALLBACK_SCORE = 99;

/** Total golfers per pick (slots 1..4). */
export const PICK_GOLFER_COUNT = 4;

/** "Best of N" — only the top 3 of 4 count toward the total. */
export const COUNTING_GOLFER_COUNT = 3;

/**
 * Top-tier ceiling. Golfers with OWGR rank 1..24 are top-tier;
 * 25+ (or unranked) are dark-horse. Mirrors the schema's
 * GENERATED column `is_dark_horse = (owgr_rank > 24)`.
 */
export const TOP_TIER_MAX_OWGR_RANK = 24;

// ── Rule Application ─────────────────────────────────────────
/**
 * Apply all per-golfer fantasy rules to a raw ESPN competitor entry.
 * Pure — no I/O.
 *
 * `cutMade` lets the caller signal whether the tournament cut has
 * officially been made (post-Round-2). When true, the made-cut cap
 * applies even during active play. When false (default), active live
 * scores are returned as-is — the cap is reserved for `complete` or
 * post-cut play. This fixes bug #5.1 (cap firing mid-Round-1).
 *
 * Bug #5.2: when a golfer is missed-cut but `cutScore` is null, we
 * return MISSED_CUT_FALLBACK_SCORE rather than `rawScore + 1` (which
 * could produce a sub-par fantasy score that beats legitimate cut
 * survivors).
 */
export function applyFantasyRules(params: {
  scoreToParRaw: string;   // ESPN string like "-4", "E", "+2"
  espnStatus: string;      // ESPN status string
  cutScore: number | null; // Tournament cut line (strokes to par)
  cutMade?: boolean;       // Has the cut been officially made? Default false.
}): {
  fantasyScore: number | null;
  status: Score['status'];
} {
  const { scoreToParRaw, espnStatus, cutScore, cutMade = false } = params;
  const status = mapESPNStatus(espnStatus);
  const rawScore = parseESPNScore(scoreToParRaw);

  switch (status) {
    case 'missed_cut':
      // Rule 3a: missed cut = cut + penalty strokes.
      // Bug #5.2 fix: when cutScore is null, use a clearly losing
      // fallback rather than rawScore+1.
      return {
        fantasyScore: cutScore !== null
          ? cutScore + MISSED_CUT_PENALTY_STROKES
          : MISSED_CUT_FALLBACK_SCORE,
        status: 'missed_cut',
      };

    case 'complete':
      // Rule 3b: tournament-final cap applies to made-cut golfers.
      if (cutScore !== null) {
        return { fantasyScore: Math.min(rawScore, cutScore), status };
      }
      return { fantasyScore: rawScore, status };

    case 'active':
      // Rule 3c: live score as-is. The cap is a final-score rule and
      // does NOT apply during active rounds unless the cut has been
      // officially made. Bug #5.1 fix.
      if (cutMade && cutScore !== null) {
        return { fantasyScore: Math.min(rawScore, cutScore), status };
      }
      return { fantasyScore: rawScore, status };

    case 'withdrawn':
    case 'disqualified':
      // Rule 3d: no score; flag for replacement window.
      return { fantasyScore: null, status };

    default:
      // Defensive — mapESPNStatus already normalizes unknowns to
      // 'active', so this branch should be unreachable in practice.
      return { fantasyScore: rawScore, status: 'active' };
  }
}

// ── Top-3 Calculation ────────────────────────────────────────
/**
 * Given 4 golfer scores, return the best COUNTING_GOLFER_COUNT (3)
 * and their sum. Lower = better (it's golf).
 *
 * Partial-data semantics (bug #5.3 — current spec):
 *   4 valid scores → best 3 sum
 *   3 valid scores → sum of all 3
 *   2 valid scores → sum of those 2 (no penalty)
 *   1 valid score  → that score
 *   0 valid scores → total = null (no rank)
 *
 * This is the "no penalty for missing data" approach. A user with
 * fewer valid scores can outrank a user with 3 valid scores. Pinned
 * by tests so any future change (e.g. to tied/pro-rated) surfaces.
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

  const top = scored.slice(0, COUNTING_GOLFER_COUNT);
  const total = top.reduce((sum, x) => sum + x.score, 0);

  return {
    countingIndices: top.map(x => x.index),
    total,
  };
}

// ── Full League Result Computation ───────────────────────────
/**
 * Compute fantasy results for all picks in a league for a tournament.
 * Pure — caller supplies the pre-built scoreMap (keyed by golfer UUID).
 *
 * Replacement handling: if a slot's primary golfer was replaced
 * (`was_replaced` + `replaced_by_golfer_id`), uses the replacement's
 * fantasy_score instead.
 *
 * Rank assignment: lower total wins. Ties get the same rank — i.e.,
 * "1, 2, 2, 4" (skip 3 after a tie at 2). Players with `total = null`
 * (e.g. all four golfers WD/DQ) are not assigned a rank.
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
      // Annotated as number|null so TS doesn't infer the literal `null`
      // and reject the rank assignment loop below under strictNullChecks.
      rank:            null as number | null,
    };
  });

  // Assign ranks (lower total = better rank). Ties share a rank.
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
 * Top tier means OWGR rank 1..TOP_TIER_MAX_OWGR_RANK (24). The schema
 * computes ``is_dark_horse`` as ``GENERATED ALWAYS AS (owgr_rank > 24)
 * STORED``, which evaluates to NULL when ``owgr_rank`` is NULL — and
 * JS treats that null as falsy, so the previous ``if
 * (golfer.is_dark_horse)`` incorrectly let UNRANKED golfers slide into
 * top-tier slots.
 *
 * Source-of-truth alignment with ``src/lib/rankings.ts:isDarkHorse``
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
 * matches ``src/lib/rankings.ts:isDarkHorse(null) === true``.
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
  if (unique.size < PICK_GOLFER_COUNT) {
    errors.push('You cannot pick the same golfer more than once.');
  }

  // ── Slots 1-2 must be top tier (OWGR rank 1..TOP_TIER_MAX_OWGR_RANK) ──
  const topTierSlots = [g1, g2];
  topTierSlots.forEach((id, i) => {
    const golfer = golfers.find(g => g.id === id);
    if (!golfer) return;
    if (!isTopTierEligible(golfer)) {
      const rankNote = golfer.owgr_rank
        ? `ranked ${golfer.owgr_rank}`
        : 'unranked';
      errors.push(
        `Slot ${i + 1} must be a top-tier golfer (ranked 1–${TOP_TIER_MAX_OWGR_RANK}). ${golfer.name} is ${rankNote}.`
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
        `Slot ${i + 3} must be a dark horse (ranked ${TOP_TIER_MAX_OWGR_RANK + 1}+ or unranked). ${golfer.name} is ranked ${golfer.owgr_rank}.`
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
 *
 * Rule: replacement must (a) not have teed off yet AND (b) still be in
 * the field as active. round_1 IS NULL is the "hasn't teed off"
 * predicate (no first-round score recorded). status must be 'active' so
 * a withdrawn / disqualified / missed-cut golfer can't be selected as
 * a replacement even if their round_1 column happens to be null
 * (e.g. WD before play started).
 *
 * Signature mirrors the actual `scores` row shape so callers don't have
 * to compute a synthetic `teed_off` flag.
 */
export function isReplacementEligible(score: {
  status: string;
  round_1: number | null;
}): boolean {
  return score.round_1 === null && score.status === 'active';
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
