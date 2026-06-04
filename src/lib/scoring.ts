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
//        a. MISSED CUT  → fixed +MISSED_CUT_PENALTY_STROKES added to
//                         the user's total as a separate "penalty"
//                         line. The golfer is NOT eligible for the
//                         top-3 pool. (Rule revised 2026-05-17.)
//        b. MADE CUT    → final score capped at cut_line (can't be worse)
//        c. ACTIVE      → live score as-is (no cap during live play)
//        d. WD / DQ     → no score; eligible for replacement
//   4. TOP 3 OF NON-MISSED-CUT — your best 3 made-cut/active/complete
//      golfer scores sum into "top-3". A missed-cut golfer is excluded
//      from this pool and adds the flat penalty above instead. Lower =
//      better (it's golf). Total = top-3 sum + (missed-cut count × 1).
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
/**
 * Flat penalty (in strokes) added to the user's total for each
 * golfer in their foursome who missed the cut.
 *
 * Revised 2026-05-17: previously this was added to the cut line to
 * compute a per-golfer fantasy score (cut + 1), and that score went
 * into the top-3 pool. The new rule: missed-cut golfers are excluded
 * from top-3 entirely, and the penalty is summed into the total as
 * a separate line item shown on the leaderboard ("Missed cut - X").
 */
export const MISSED_CUT_PENALTY_STROKES = 1;

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
 * Missed-cut handling (revised 2026-05-17): per-golfer `fantasyScore`
 * is the flat `MISSED_CUT_PENALTY_STROKES` constant. The cut line
 * doesn't enter the math anymore — every missed-cut golfer
 * contributes the same penalty regardless of how far over the cut
 * they were, and `computeLeagueResults` excludes these from the
 * top-3 pool and sums the penalty separately. Closes #5.2 (null
 * cut score) as a side effect — there's no longer a code path that
 * needs a fallback score.
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
      // Rule 3a (revised): flat penalty, independent of cut line and
      // raw score. computeLeagueResults excludes this golfer from
      // top-3 and sums the penalty separately into the total.
      return {
        fantasyScore: MISSED_CUT_PENALTY_STROKES,
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
 * Partial-data semantics:
 *   4 valid scores → best 3 sum (the normal post-round case)
 *   3 valid scores → sum of all 3
 *   2 valid scores → sum of those 2 (in-progress, no penalty)
 *   1 valid score  → that score (in-progress, no penalty)
 *   0 valid scores → total = null (no rank — display as "—")
 *
 * Why "no penalty for missing data" is intentional: submission-time
 * validation in `validatePick` already rejects picks with fewer than
 * 4 golfers, so the only way to land here with < 4 valid scores is
 * the transient mid-tournament state where some of the user's 4
 * picks have teed off and posted a `round_1` while others haven't.
 * That window is short (a few hours Thursday morning) and self-
 * resolves by end of round 1.
 *
 * Penalising unscored slots ("assume +N strokes per missing") would
 * make Thursday-morning leaderboards meaningless — users whose picks
 * happen to tee off later would look like big losers even when they
 * are perfectly on-pace. Sum-of-scored gives an honest in-progress
 * estimate. Pinned by tests so any future change surfaces.
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
 * fantasy_score AND status (so a replaced-by-missed-cut golfer is
 * scored as missed-cut, not as the original WD/DQ).
 *
 * Total math (revised 2026-05-17):
 *   total = top-3 sum + (missed-cut count × MISSED_CUT_PENALTY_STROKES)
 *
 *   Top-3 pool excludes missed-cut golfers — they contribute the flat
 *   penalty instead. The dropped slot in the top-3-of-4 calc therefore
 *   becomes whichever non-missed-cut golfer has the worst score (or
 *   the slot is simply absent from the pool if the user has fewer
 *   than 4 made-cut golfers).
 *
 *   total_score = null when no golfer has scored AND no golfer missed
 *   cut (i.e. pre-Round-1, or all four WD/DQ).
 *
 * Rank assignment: lower total wins. Ties get the same rank — i.e.,
 * "1, 2, 2, 4" (skip 3 after a tie at 2). Players with `total = null`
 * are not assigned a rank.
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

    const slotEntries = golferIds.map(id => {
      if (!id) return { fantasy: null as number | null, missedCut: false };
      const score = scoreMap.get(id);
      if (!score) return { fantasy: null as number | null, missedCut: false };
      // If the slot's primary golfer was replaced, the replacement's
      // score AND status take over — both need to flow through so a
      // replacement who themselves miss the cut counts as missed-cut.
      const effective = (score.was_replaced && score.replaced_by_golfer_id)
        ? scoreMap.get(score.replaced_by_golfer_id) ?? null
        : score;
      if (!effective) return { fantasy: null as number | null, missedCut: false };
      return {
        fantasy:   effective.fantasy_score,
        missedCut: effective.status === 'missed_cut',
      };
    });

    // Top-3 pool: non-missed-cut only. A missed-cut golfer contributes
    // through the penalty bucket below, never through the pool.
    const top3Pool = slotEntries.map(e => e.missedCut ? null : e.fantasy);
    const { countingIndices, total: top3Total } = calculateTop3(top3Pool);
    const missedCutCount = slotEntries.filter(e => e.missedCut).length;
    const penaltyTotal   = missedCutCount * MISSED_CUT_PENALTY_STROKES;

    // null total only when nothing has happened — no scored golfers
    // AND no missed cuts. Otherwise the penalty alone gives us a
    // meaningful total (e.g. all 4 missed cut → total = 4).
    //
    // pick.penalty_strokes (default 0) layers a SECOND penalty class:
    // the missed-deadline auto-assign sweep (sync.ts:sweepMissedPicks)
    // sets it to 2 when a user didn't submit by pick_deadline. It
    // applies the same way as the missed-cut penalty: always added to
    // the user's total regardless of whether any score has posted. So
    // a user who missed the deadline + had all 4 golfers miss the cut
    // = top3=null + missedCutCount=4 + penalty_strokes=2 → total = 6.
    const pickPenalty = pick.penalty_strokes ?? 0;
    let totalScore: number | null;
    if (top3Total !== null)         totalScore = top3Total + penaltyTotal + pickPenalty;
    else if (missedCutCount > 0)    totalScore = penaltyTotal + pickPenalty;
    else if (pickPenalty > 0)       totalScore = pickPenalty;
    else                            totalScore = null;

    return {
      league_id:       pick.league_id,
      tournament_id:   pick.tournament_id,
      user_id:         pick.user_id,
      golfer_1_score:  slotEntries[0].fantasy,
      golfer_2_score:  slotEntries[1].fantasy,
      golfer_3_score:  slotEntries[2].fantasy,
      golfer_4_score:  slotEntries[3].fantasy,
      counting_golfers: countingIndices.map(i => i + 1), // 1-indexed for display
      total_score:     totalScore,
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
 * User-facing message when another player in the same league +
 * tournament has already submitted the identical 4-golfer set.
 *
 * Exported as a constant so the app-layer check (validatePick below)
 * and the DB-layer race fallback (POST /api/picks catch block on
 * picks_unique_complete_foursome unique-index violation) return the
 * SAME wording. Prior to 2026-06-04 the two paths had slightly
 * different copy ("…exact combination of 4 golfers. Please choose a
 * different lineup." vs "…exact foursome. Pick a different
 * combination."), which was cosmetic but could surprise users hitting
 * the race path. Single source of truth here.
 */
export const DUPLICATE_FOURSOME_MESSAGE =
  'Another player in your league has already picked this exact ' +
  'combination of 4 golfers. Please choose a different lineup.';

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
      errors.push(DUPLICATE_FOURSOME_MESSAGE);
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

// ── Thru indicator (leaderboard "right-of-score" cell) ───────
/**
 * Format the "thru N / F / —" indicator that renders to the right of
 * each golfer's score on both leaderboard cards.
 *
 * Per Greg's 2026-06-04 spec:
 *   - "Thru N"  during a round (holes_played 1..17)
 *   - "F"       when the current round is complete (holes_played === 18)
 *               and the tournament is still in flight
 *   - ""        when the golfer is MC / WD / DQ / complete (the
 *               existing badge handles that case)
 *   - ""        when the tournament status is 'complete' (the final
 *               score is the story; no thru column needed)
 *   - "—"       in every other gap case (NULL data, 0 pre-tee-off)
 *
 * Pure formatter. No timezone math, no clock — just maps the recorded
 * holes_played + golfer + tournament status to the right string.
 */
export function formatThruIndicator(
  holesPlayed: number | null,
  golferStatus: string | null | undefined,
  tournamentStatus: string | null | undefined,
): string {
  // Tournament's over → no thru is meaningful.
  if (tournamentStatus === 'complete') return '';
  // Out of contention / done with this event → existing badge tells
  // the story; don't double-render in the thru column.
  if (
    golferStatus === 'missed_cut' ||
    golferStatus === 'withdrawn'  ||
    golferStatus === 'disqualified' ||
    golferStatus === 'complete'
  ) {
    return '';
  }
  if (holesPlayed === null || holesPlayed === undefined) return '—';
  if (holesPlayed === 0)  return '—';  // tee-off pending
  if (holesPlayed === 18) return 'F';
  if (holesPlayed > 0 && holesPlayed < 18) return `Thru ${holesPlayed}`;
  // Out-of-range fallback — shouldn't happen given the DB CHECK
  // constraint, but be defensive in render.
  return '—';
}

// ── Auto-Lineup Builder (missed-deadline sweep) ──────────────
/**
 * How many of the highest-ranked golfers in each tier are excluded
 * from the auto-pick pool. Greg's rule (2026-06-04): a user who missed
 * the deadline doesn't get to ride the consensus best names — neither
 * the top-4 top-tier (lowest owgr_rank with is_dark_horse=false) nor
 * the top-4 dark-horse (lowest owgr_rank with is_dark_horse=true).
 */
export const AUTO_LINEUP_EXCLUDE_TOP_N = 4;

/**
 * The penalty in strokes applied to an auto-assigned lineup. Stored
 * on `picks.penalty_strokes` at INSERT time; `computeLeagueResults`
 * reads it and adds it to the user's best-3-of-4 total.
 */
export const MISSED_DEADLINE_PENALTY_STROKES = 2;

/**
 * Compute the canonical sorted-pipe-delimited hash of a 4-golfer set.
 * Must match the Postgres trigger `picks_compute_tuple_hash` in
 * infra/postgres/init/00-schema.sql so app-layer dedupe via Set<hash>
 * agrees with the DB-layer UNIQUE INDEX `picks_unique_complete_foursome`.
 *
 * Exported because the auto-lineup sweep needs to seed `takenHashes`
 * from existing picks BEFORE the trigger fires.
 */
export function computeFoursomeHash(golferIds: [string, string, string, string]): string {
  return [...golferIds].sort().join('|');
}

/**
 * Result of buildAutoLineup. Discriminated so the caller can distinguish
 * a successful generation from a graceful failure (pool too small,
 * unique combos exhausted, etc.).
 */
export type AutoLineupResult =
  | {
      ok: true;
      golferIds: [string, string, string, string];
      hash:      string;
      // Slot 1 + 2 from this pool (top-tier minus excluded top-N).
      topGolferIds:  [string, string];
      // Slot 3 + 4 from this pool (dark-horse minus excluded top-N).
      darkGolferIds: [string, string];
    }
  | { ok: false; reason: string };

/**
 * Build a random, valid, unique auto-lineup for a user who missed the
 * pick deadline.
 *
 * Rules enforced (matches validatePick semantics):
 *   - 2 top-tier golfers in slots 1+2 (is_dark_horse === false)
 *   - 2 dark-horse golfers in slots 3+4 (is_dark_horse !== false)
 *   - All 4 distinct
 *   - Top-N (default 4) of each tier by owgr_rank are EXCLUDED from
 *     the pool. Ties are broken stably so the exclusion is
 *     deterministic given the input ordering.
 *   - Generated 4-set must NOT collide with any hash in
 *     `takenHashes` (existing picks for this league + tournament).
 *
 * Strategy:
 *   1. Random sampling with `attempts` retries (default 50). Cheap
 *      and fast for the realistic case (taken set is small vs the
 *      combinatorial space).
 *   2. If random sampling can't find an unused combo, deterministic
 *      exhaustive search over all top-pair × dark-pair tuples in
 *      input order. Guarantees a hit if any unique combo exists.
 *   3. If exhaustive search also returns nothing, `ok: false` with a
 *      reason — sweep caller logs and skips the user (no pick row
 *      inserted, so the tournament treats them as before).
 *
 * `rng` defaults to Math.random; tests pass a deterministic source.
 */
export function buildAutoLineup(args: {
  fieldGolfers: Array<{
    id:            string;
    name:          string;
    owgr_rank:     number | null;
    is_dark_horse: boolean | null;
  }>;
  takenHashes:    Set<string>;
  excludeTopN?:   number;
  attempts?:      number;
  rng?:           () => number;
}): AutoLineupResult {
  const excludeTopN = args.excludeTopN ?? AUTO_LINEUP_EXCLUDE_TOP_N;
  const attempts    = args.attempts    ?? 50;
  const rng         = args.rng         ?? Math.random;

  // Split by tier — same predicates as isTopTierEligible /
  // isDarkHorseEligible above for one source of truth.
  const topTierAll  = args.fieldGolfers.filter(g => g.is_dark_horse === false);
  const darkHorseAll = args.fieldGolfers.filter(g => g.is_dark_horse !== false);

  // Sort each tier by owgr_rank ascending, NULL ranks LAST so they're
  // never accidentally treated as "best". Drop the first N → pool.
  const byRankNullsLast = (a: { owgr_rank: number | null }, b: { owgr_rank: number | null }) => {
    const ar = a.owgr_rank ?? Number.POSITIVE_INFINITY;
    const br = b.owgr_rank ?? Number.POSITIVE_INFINITY;
    return ar - br;
  };
  const topPool  = [...topTierAll].sort(byRankNullsLast).slice(excludeTopN);
  const darkPool = [...darkHorseAll].sort(byRankNullsLast).slice(excludeTopN);

  if (topPool.length < 2) {
    return {
      ok: false,
      reason: `top-tier pool too small (have ${topPool.length} after excluding top ${excludeTopN}, need ≥2)`,
    };
  }
  if (darkPool.length < 2) {
    return {
      ok: false,
      reason: `dark-horse pool too small (have ${darkPool.length} after excluding top ${excludeTopN}, need ≥2)`,
    };
  }

  // ── Strategy 1: random sampling, retry on collision ──
  const pick2 = <T>(pool: T[]): [T, T] => {
    // Reservoir-y unordered draw of 2 distinct indices via Fisher-Yates
    // partial shuffle of {0..n-1} on the first 2 slots. Avoids the
    // bias of "pick one, then pick another != first".
    const i = Math.floor(rng() * pool.length);
    let j = Math.floor(rng() * (pool.length - 1));
    if (j >= i) j += 1;
    return [pool[i], pool[j]];
  };

  for (let tryNum = 0; tryNum < attempts; tryNum++) {
    const [t1, t2] = pick2(topPool);
    const [d1, d2] = pick2(darkPool);
    const ids: [string, string, string, string] = [t1.id, t2.id, d1.id, d2.id];
    // Distinctness across tiers — defensive, shouldn't actually happen
    // since topPool / darkPool are disjoint by definition, but the
    // schema allows null is_dark_horse which we lump into dark-horse.
    if (new Set(ids).size !== 4) continue;
    const hash = computeFoursomeHash(ids);
    if (!args.takenHashes.has(hash)) {
      return {
        ok: true,
        golferIds:     ids,
        hash,
        topGolferIds:  [t1.id, t2.id],
        darkGolferIds: [d1.id, d2.id],
      };
    }
  }

  // ── Strategy 2: deterministic exhaustive search ──
  // Iterate top-pair × dark-pair in input order. Guaranteed to find
  // any unique combo that exists. Complexity is O((|top| C 2) × (|dark| C 2));
  // with realistic pools (~30 top, ~100 dark post-exclusion) this is
  // ~435 × 4950 ≈ 2M iterations worst case — well under 100ms.
  for (let i = 0; i < topPool.length; i++) {
    for (let j = i + 1; j < topPool.length; j++) {
      for (let k = 0; k < darkPool.length; k++) {
        for (let l = k + 1; l < darkPool.length; l++) {
          const ids: [string, string, string, string] = [
            topPool[i].id, topPool[j].id,
            darkPool[k].id, darkPool[l].id,
          ];
          if (new Set(ids).size !== 4) continue;
          const hash = computeFoursomeHash(ids);
          if (!args.takenHashes.has(hash)) {
            return {
              ok: true,
              golferIds:     ids,
              hash,
              topGolferIds:  [topPool[i].id, topPool[j].id],
              darkGolferIds: [darkPool[k].id, darkPool[l].id],
            };
          }
        }
      }
    }
  }

  return {
    ok: false,
    reason: 'no unique foursome possible — every combination collides with an existing pick',
  };
}
