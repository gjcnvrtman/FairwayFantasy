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
import { TEAM_4, pickGolferIds, teamSlots, type TeamShape } from './team-shape';

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

// TOP_TIER_MAX_OWGR_RANK removed 2026-06-13 — tier is per-tournament-
// field now, not global OWGR rank. The size of the top tier lives in
// src/lib/field-tiers.ts as TOP_TIER_SIZE.

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
export function calculateTop3(
  scores: (number | null)[],
  /** Best N count — 3 for 4-man teams, 4 for 6-man majors. */
  countingCount: number = COUNTING_GOLFER_COUNT,
): {
  countingIndices: number[];  // Which slots are counting (0-indexed)
  total: number | null;
} {
  const scored = scores
    .map((s, i) => ({ score: s, index: i }))
    .filter(x => x.score !== null) as Array<{ score: number; index: number }>;

  if (scored.length === 0) return { countingIndices: [], total: null };

  // Sort ascending (lower = better in golf)
  scored.sort((a, b) => a.score - b.score);

  const top = scored.slice(0, countingCount);
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
  opts: {
    /** Strokes per missed-cut golfer (leagues.missed_cut_penalty,
     *  migration 025). Defaults to the pre-025 constant. */
    missedCutPenalty?: number;
    /** Team shape for this league + tournament (migration 026).
     *  Defaults to 4-man: best 3 of 4. */
    shape?: TeamShape;
  } = {},
): Omit<FantasyResult, 'id' | 'updated_at'>[] {
  const missedCutPenalty = opts.missedCutPenalty ?? MISSED_CUT_PENALTY_STROKES;
  const shape = opts.shape ?? TEAM_4;
  const results = picks.map(pick => {
    const golferIds = pickGolferIds(pick, shape);

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
      const missedCut = effective.status === 'missed_cut';
      // scores.fantasy_score is shared across leagues and holds the
      // default penalty for MC golfers; show this league's penalty
      // instead so the per-golfer column matches the total.
      return {
        fantasy:   missedCut ? missedCutPenalty : effective.fantasy_score,
        missedCut,
      };
    });

    // Top-3 pool: non-missed-cut only. A missed-cut golfer contributes
    // through the penalty bucket below, never through the pool.
    const top3Pool = slotEntries.map(e => e.missedCut ? null : e.fantasy);
    const { countingIndices, total: top3Total } = calculateTop3(top3Pool, shape.counting);
    const missedCutCount = slotEntries.filter(e => e.missedCut).length;
    const penaltyTotal   = missedCutCount * missedCutPenalty;

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
      // 6-man majors only; null for 4-man teams.
      golfer_5_score:  slotEntries[4]?.fantasy ?? null,
      golfer_6_score:  slotEntries[5]?.fantasy ?? null,
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
//
// Tier eligibility is per-tournament-field, not global. The caller
// passes the Set of top-tier golfer IDs computed from the field via
// `computeTopTierIds` in src/lib/field-tiers.ts. Membership in that
// Set = top-tier; everyone else in the field = dark horse.
//
// (Replaced the prior is_dark_horse-column-based check 2026-06-13 so
// "top tier" actually means "top 24 in THIS tournament" rather than
// "global OWGR 1..24". Weak-field events used to have only ~5 top-
// tier-eligible golfers; now the strongest 24 in any field qualify.)

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

/** Duplicate-team message for any team size (6-man majors). */
export function duplicateTeamMessage(size: number): string {
  return size === 4
    ? DUPLICATE_FOURSOME_MESSAGE
    : 'Another player in your league has already picked this exact ' +
      `combination of ${size} golfers. Please choose a different lineup.`;
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
  golfers: Array<{ id: string; owgr_rank: number | null; name: string }>;
  topTierIds: Set<string>;
  existingPicks: Array<{
    golfer_1_id: string; golfer_2_id: string; golfer_3_id: string; golfer_4_id: string;
    golfer_5_id?: string | null; golfer_6_id?: string | null;
  }>;
  /** Team shape (migration 026). Defaults to 4-man. */
  shape?: TeamShape;
}): string[] {
  const { golfers, topTierIds, existingPicks } = params;
  const shape = params.shape ?? TEAM_4;
  const errors: string[] = [];

  const ids = teamSlots(shape).map(s => params.golferIds[s - 1] ?? null);

  // ── Every slot must be filled ──
  if (ids.some(id => !id)) {
    errors.push(`You must select all ${shape.size} golfers.`);
    return errors;
  }
  const picked = ids as string[];

  // ── No duplicates within pick ──
  if (new Set(picked).size < shape.size) {
    errors.push('You cannot pick the same golfer more than once.');
  }

  // ── Top-tier slots (1..topTier) must be top tier (top 24 in this field) ──
  picked.slice(0, shape.topTier).forEach((id, i) => {
    const golfer = golfers.find(g => g.id === id);
    if (!golfer) return;
    if (!topTierIds.has(golfer.id)) {
      const rankNote = golfer.owgr_rank
        ? `ranked ${golfer.owgr_rank}`
        : 'unranked';
      errors.push(
        `Slot ${i + 1} must be a top-tier golfer (top ${topTierIds.size} in this tournament's field). ${golfer.name} is ${rankNote}.`
      );
    }
  });

  // ── Remaining slots must be dark horses (everyone else in the field) ──
  picked.slice(shape.topTier).forEach((id, i) => {
    const golfer = golfers.find(g => g.id === id);
    if (!golfer) return;
    if (topTierIds.has(golfer.id)) {
      errors.push(
        `Slot ${i + shape.topTier + 1} must be a dark horse (any golfer in the field outside the top ${topTierIds.size}). ${golfer.name} is ranked ${golfer.owgr_rank}.`
      );
    }
  });

  // ── No two players in the league can pick the identical set ──
  const newSet = new Set(picked);
  for (const existing of existingPicks) {
    const existingSet = new Set(
      [existing.golfer_1_id, existing.golfer_2_id, existing.golfer_3_id,
       existing.golfer_4_id, existing.golfer_5_id, existing.golfer_6_id]
        .filter((id): id is string => !!id),
    );
    if (
      newSet.size === existingSet.size &&
      [...newSet].every(id => existingSet.has(id))
    ) {
      errors.push(duplicateTeamMessage(shape.size));
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
export function computeFoursomeHash(golferIds: readonly string[]): string {
  // Any team size — the trigger (migration 026) hashes all non-null
  // slots the same way.
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
      /** Slot order: top-tier golfers first, then dark horses. */
      golferIds: string[];
      hash:      string;
      // Top-tier slots from this pool (top-tier minus excluded top-N).
      topGolferIds:  string[];
      // Dark-horse slots from this pool (dark-horse minus excluded top-N).
      darkGolferIds: string[];
    }
  | { ok: false; reason: string };

/** Lexicographic k-combinations of pool indices, generated lazily. */
function* combinations(n: number, k: number): Generator<number[]> {
  if (k > n) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield [...idx];
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i] += 1;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

/**
 * Build a random, valid, unique auto-lineup for a user who missed the
 * pick deadline.
 *
 * Rules enforced (matches validatePick semantics):
 *   - 2 top-tier golfers in slots 1+2 (id ∈ topTierIds)
 *   - 2 dark-horse golfers in slots 3+4 (id ∉ topTierIds)
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
  }>;
  topTierIds:     Set<string>;
  takenHashes:    Set<string>;
  excludeTopN?:   number;
  attempts?:      number;
  rng?:           () => number;
  /** Team shape (migration 026). Defaults to 4-man (2 + 2). */
  shape?:         TeamShape;
}): AutoLineupResult {
  const excludeTopN = args.excludeTopN ?? AUTO_LINEUP_EXCLUDE_TOP_N;
  const attempts    = args.attempts    ?? 50;
  const rng         = args.rng         ?? Math.random;
  const shape       = args.shape       ?? TEAM_4;
  const nTop        = shape.topTier;
  const nDark       = shape.size - shape.topTier;

  // Split by per-tournament tier (see src/lib/field-tiers.ts).
  // Anything in topTierIds → top pool; everyone else in the field → dark.
  const topTierAll   = args.fieldGolfers.filter(g => args.topTierIds.has(g.id));
  const darkHorseAll = args.fieldGolfers.filter(g => !args.topTierIds.has(g.id));

  // Sort each tier by owgr_rank ascending, NULL ranks LAST so they're
  // never accidentally treated as "best". Drop the first N → pool.
  const byRankNullsLast = (a: { owgr_rank: number | null }, b: { owgr_rank: number | null }) => {
    const ar = a.owgr_rank ?? Number.POSITIVE_INFINITY;
    const br = b.owgr_rank ?? Number.POSITIVE_INFINITY;
    return ar - br;
  };
  const topPool  = [...topTierAll].sort(byRankNullsLast).slice(excludeTopN);
  const darkPool = [...darkHorseAll].sort(byRankNullsLast).slice(excludeTopN);

  if (topPool.length < nTop) {
    return {
      ok: false,
      reason: `top-tier pool too small (have ${topPool.length} after excluding top ${excludeTopN}, need ≥${nTop})`,
    };
  }
  if (darkPool.length < nDark) {
    return {
      ok: false,
      reason: `dark-horse pool too small (have ${darkPool.length} after excluding top ${excludeTopN}, need ≥${nDark})`,
    };
  }

  // ── Strategy 1: random sampling, retry on collision ──
  // Unordered draw of k distinct pool members. For k=2 this keeps the
  // original two-draw sequence exactly (tests pin it with a seeded rng);
  // larger k uses a partial Fisher-Yates shuffle.
  const pickK = <T>(pool: T[], k: number): T[] => {
    if (k === 2) {
      const i = Math.floor(rng() * pool.length);
      let j = Math.floor(rng() * (pool.length - 1));
      if (j >= i) j += 1;
      return [pool[i], pool[j]];
    }
    const idx = pool.map((_, i) => i);
    for (let s = 0; s < k; s++) {
      const r = s + Math.floor(rng() * (idx.length - s));
      [idx[s], idx[r]] = [idx[r], idx[s]];
    }
    return idx.slice(0, k).map(i => pool[i]);
  };

  const result = (top: string[], dark: string[]): AutoLineupResult | null => {
    const ids = [...top, ...dark];
    // Distinctness across tiers — defensive. topPool and darkPool are
    // disjoint by construction (partition of the field on topTierIds
    // membership), so duplicates here would mean a caller bug.
    if (new Set(ids).size !== ids.length) return null;
    const hash = computeFoursomeHash(ids);
    if (args.takenHashes.has(hash)) return null;
    return { ok: true, golferIds: ids, hash, topGolferIds: top, darkGolferIds: dark };
  };

  for (let tryNum = 0; tryNum < attempts; tryNum++) {
    const top  = pickK(topPool,  nTop).map(g => g.id);
    const dark = pickK(darkPool, nDark).map(g => g.id);
    const r = result(top, dark);
    if (r) return r;
  }

  // ── Strategy 2: deterministic exhaustive search ──
  // Lexicographic top-combos × dark-combos in input order, generated
  // lazily — guaranteed to find any unique combo that exists, and
  // stops at the first free one (the space is huge vs. a handful of
  // taken teams, so this ends almost immediately in practice).
  for (const tc of combinations(topPool.length, nTop)) {
    for (const dc of combinations(darkPool.length, nDark)) {
      const r = result(tc.map(i => topPool[i].id), dc.map(i => darkPool[i].id));
      if (r) return r;
    }
  }

  return {
    ok: false,
    reason: `no unique ${shape.size === 4 ? 'foursome' : `${shape.size}-golfer team`} possible — every combination collides with an existing pick`,
  };
}
