// ============================================================
// COURSE-FIT SCORING ENGINE — pure functions, no I/O.
//
// Scores one golfer against one course-tournament combination across
// the six spec subscores:
//
//   1. course_fit       — weighted SG vs course importance dims
//   2. recent_form      — last N finishes, recency-weighted
//   3. long_term        — OWGR-derived baseline ability
//   4. course_history   — finishes at this specific course
//   5. cut_probability  — Datagolf preds preferred, OWGR fallback
//   6. upside           — SG ceiling × recent-form inconsistency
//
// All subscores are 0..100. The composite is Σ weight_i × subscore_i.
// Lower = worse golfer, higher = better. The optimizer downstream
// derives "projected strokes to par" (lower = better) from composite.
//
// Missing-input policy: every input is allowed to be NULL. The scorer
// substitutes the best available proxy and records the missing field
// name in `missingInputs`. Callers (the predictor) surface that list
// to the admin so they see exactly what wasn't available.
//
// All functions in this file are PURE — no DB reads, no clock reads,
// no I/O. Test fixtures pass synthetic typed inputs.
// ============================================================

// ── Input types ──────────────────────────────────────────────

/** A subset of golfer_stat_snapshots used by the scorer. */
export interface GolferStatRow {
  sg_total: number | null;
  sg_ott: number | null;
  sg_app: number | null;
  sg_arg: number | null;
  sg_putt: number | null;
  driving_distance: number | null;
  driving_accuracy_pct: number | null;
  gir_pct: number | null;
  scoring_avg: number | null;
  birdie_avg: number | null;
  bogey_avg: number | null;
  made_cut_pct: number | null;
}

/** A subset of datagolf_tournament_predictions used by the scorer. */
export interface DatagolfPredsRow {
  win_prob: number | null;
  top_5_prob: number | null;
  top_10_prob: number | null;
  top_20_prob: number | null;
  make_cut_prob: number | null;
}

/** One historical finish for a golfer. Score is the per-event finish
 *  (1..N, MC = special-cased). All we need for the form math. */
export interface Finish {
  /** Tournament finish position. 1 = win, 999 = missed cut sentinel. */
  position: number;
  /** Whether the golfer missed the cut. */
  missedCut: boolean;
  /** ISO date — most-recent-first sort key. */
  eventDate: string;
}

/** The five SG dimensions of a course. All 0..1, NULL = unknown. */
export interface CourseProfile {
  scoringDifficulty: number | null;
  drivingDistanceImportance: number | null;
  drivingAccuracyImportance: number | null;
  approachImportance: number | null;
  aroundGreenImportance: number | null;
  puttingImportance: number | null;
}

/** Six weights that should sum to ~1.0; CHECK in scoreGolfer. */
export interface ScoringWeights {
  courseFit: number;
  recentForm: number;
  longTerm: number;
  courseHistory: number;
  cutProbability: number;
  upside: number;
}

export interface GolferScoringInputs {
  golferId: string;
  owgrRank: number | null;
  stats: GolferStatRow | null;
  datagolf: DatagolfPredsRow | null;
  /** Recent events, MOST-RECENT FIRST. Max ~6 used. */
  recentFinishes: Finish[];
  /** Prior visits to THIS course. Max 5 used. */
  courseHistory: Finish[];
  /** Prior visits to comparable courses. Optional. */
  comparableHistory: Finish[];
}

// ── Output type ──────────────────────────────────────────────
export interface GolferSubscores {
  courseFit: number;
  recentForm: number;
  longTerm: number;
  courseHistory: number;
  cutProbability: number;
  upside: number;
  /** weighted composite, 0..100 */
  composite: number;
  /** Names of inputs that fell back to a proxy. e.g. ["sg_app", "course_history"] */
  missingInputs: string[];
  /** Lower = better. Predicted strokes vs par over the whole event. */
  projectedStrokesToPar: number;
  /** Probability of making the cut. 0..1. */
  projectedCutProb: number;
  /** Human-readable, one sentence, for tooltips. */
  explanation: string;
}

// ── Constants — tunable in code, not config ──────────────────

/**
 * Maps `finish position` → subscore (0..100). Lower position = higher
 * score. Missed cut is special-cased to 10 (worse than 60th place).
 */
function finishToScore(f: Finish): number {
  if (f.missedCut) return 10;
  const p = f.position;
  if (p <= 1) return 100;
  if (p <= 2) return 95;
  if (p <= 5) return 88;
  if (p <= 10) return 75;
  if (p <= 20) return 60;
  if (p <= 30) return 50;
  if (p <= 40) return 40;
  if (p <= 60) return 30;
  return 20;
}

/** Recency-weighted moving average of `finishes` (most-recent-first).
 *  Returns the weighted score and the count of finishes actually used.
 *  Weights normalize if fewer than 6 finishes are present. */
function recencyWeightedFinish(finishes: Finish[], k: number = 6): {
  score: number; count: number;
} {
  const used = finishes.slice(0, k);
  if (used.length === 0) return { score: 0, count: 0 };
  // Geometric-ish: most-recent worth more.
  const rawW = [0.30, 0.25, 0.18, 0.13, 0.09, 0.05].slice(0, used.length);
  const norm = rawW.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < used.length; i++) {
    acc += (rawW[i] / norm) * finishToScore(used[i]);
  }
  return { score: acc, count: used.length };
}

/** OWGR rank → 0..100 baseline ability. Rank 1 = 100, rank 200 = 0. */
function owgrToScore(rank: number | null): number | null {
  if (rank == null) return null;
  if (rank <= 1) return 100;
  if (rank >= 200) return 0;
  return 100 - ((rank - 1) / 199) * 100;
}

/** Stdev of the finish-scores within an array, sample-size-weighted. */
function stdevOfFinishScores(finishes: Finish[]): number {
  if (finishes.length < 2) return 0;
  const scores = finishes.map(finishToScore);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((acc, s) => acc + (s - mean) ** 2, 0) / scores.length;
  return Math.sqrt(variance);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ── Subscore: course fit ─────────────────────────────────────

/**
 * Weighted SG dot product against course importances. Each SG axis
 * contributes its `sg_X × importance_X / sum_importances` to the raw
 * score, then we map [-2.5, +2.5] SG-units → [0, 100].
 *
 * If stats are missing entirely, fall back to OWGR mapping. If course
 * importances are missing, fall back to equal weighting.
 *
 * Returns the score plus the list of fields it had to substitute.
 */
function scoreCourseFit(
  stats: GolferStatRow | null,
  course: CourseProfile,
  owgr: number | null,
): { score: number; missing: string[] } {
  const missing: string[] = [];

  if (!stats) {
    missing.push('stats');
    const fb = owgrToScore(owgr);
    if (fb == null) missing.push('owgr_rank');
    return { score: fb ?? 50, missing };
  }

  // Pull the four SG dimensions; null → 0 with a missing flag.
  const dims: { key: keyof GolferStatRow; imp: number | null }[] = [
    { key: 'sg_ott', imp: course.drivingDistanceImportance },
    { key: 'sg_app', imp: course.approachImportance },
    { key: 'sg_arg', imp: course.aroundGreenImportance },
    { key: 'sg_putt', imp: course.puttingImportance },
  ];

  // Course importances missing → equal-weight fallback.
  const courseImps = dims.map(d => d.imp);
  const courseMissing = courseImps.every(v => v == null);
  if (courseMissing) {
    missing.push('course_importance');
  }
  const weights = courseImps.map(v => v == null ? 0.25 : v);
  const wsum = weights.reduce((a, b) => a + b, 0) || 1;

  let raw = 0;
  for (let i = 0; i < dims.length; i++) {
    const v = stats[dims[i].key] as number | null;
    if (v == null) {
      missing.push(dims[i].key as string);
      continue;
    }
    raw += (weights[i] / wsum) * v;
  }
  // Map [-2.5, +2.5] → [0, 100]
  const mapped = clamp(50 + (raw / 2.5) * 50, 0, 100);
  return { score: mapped, missing };
}

// ── Subscore: recent form ────────────────────────────────────

function scoreRecentForm(finishes: Finish[]): { score: number; missing: string[] } {
  const r = recencyWeightedFinish(finishes, 6);
  if (r.count === 0) return { score: 0, missing: ['recent_finishes'] };
  return { score: r.score, missing: [] };
}

// ── Subscore: long-term ability ──────────────────────────────

function scoreLongTerm(owgr: number | null): { score: number; missing: string[] } {
  const v = owgrToScore(owgr);
  if (v == null) return { score: 25, missing: ['owgr_rank'] };
  return { score: v, missing: [] };
}

// ── Subscore: course history ─────────────────────────────────

function scoreCourseHistory(
  courseHistory: Finish[],
  comparableHistory: Finish[],
  recentForm: number,
): { score: number; missing: string[] } {
  if (courseHistory.length > 0) {
    // Avg the score of up to last 5 visits.
    const last5 = courseHistory.slice(0, 5);
    const avg = last5.reduce((a, f) => a + finishToScore(f), 0) / last5.length;
    return { score: avg, missing: [] };
  }
  if (comparableHistory.length > 0) {
    const last5 = comparableHistory.slice(0, 5);
    const avg = last5.reduce((a, f) => a + finishToScore(f), 0) / last5.length;
    return { score: avg * 0.9, missing: ['course_history'] };
  }
  // Fall back to recent_form × 0.8 — same-shape proxy.
  return { score: recentForm * 0.8, missing: ['course_history', 'comparable_history'] };
}

// ── Subscore: cut probability ────────────────────────────────

function scoreCutProbability(
  dg: DatagolfPredsRow | null,
  owgr: number | null,
  finishes: Finish[],
): { score: number; missing: string[]; rawProb: number } {
  // Datagolf preds is the cleanest input; if present, prefer it.
  if (dg?.make_cut_prob != null) {
    const p = clamp(dg.make_cut_prob, 0, 1);
    return { score: p * 100, missing: [], rawProb: p };
  }
  const missing: string[] = ['make_cut_prob'];

  // Derive from OWGR + recent made-cut rate.
  let p = 0.55; // population baseline ~55%
  const owgrBase = owgrToScore(owgr);
  if (owgrBase != null) {
    // top 10 ~0.92, top 50 ~0.80, top 100 ~0.68, top 200 ~0.55
    p = 0.55 + (owgrBase / 100) * 0.40;
  } else {
    missing.push('owgr_rank');
  }
  if (finishes.length >= 3) {
    const recentRate = finishes.filter(f => !f.missedCut).length / finishes.length;
    p = 0.7 * p + 0.3 * recentRate;
  } else {
    missing.push('recent_finishes');
  }
  p = clamp(p, 0.05, 0.99);
  return { score: p * 100, missing, rawProb: p };
}

// ── Subscore: upside ─────────────────────────────────────────

function scoreUpside(
  stats: GolferStatRow | null,
  finishes: Finish[],
  recentFormScore: number,
): { score: number; missing: string[] } {
  // Ceiling = SG total if available, else recent form.
  const ceiling = stats?.sg_total != null
    ? clamp(50 + (stats.sg_total / 2.5) * 50, 0, 100)
    : recentFormScore;

  // Inconsistency factor — high stdev of recent finishes = more upside.
  const sd = stdevOfFinishScores(finishes);
  // sd typically 5..40 for full PGA tour distribution.
  const inconsistency = clamp(sd / 30, 0, 1);    // 0..1
  const score = clamp(ceiling * (0.7 + 0.6 * inconsistency), 0, 100);

  const missing: string[] = [];
  if (stats?.sg_total == null) missing.push('sg_total');
  if (finishes.length < 2) missing.push('recent_finishes');
  return { score, missing };
}

// ── Public entry point ──────────────────────────────────────

/** Throws if weights don't sum to 1.0 within ±0.005. */
export function validateWeights(w: ScoringWeights): void {
  const sum = w.courseFit + w.recentForm + w.longTerm
            + w.courseHistory + w.cutProbability + w.upside;
  if (Math.abs(sum - 1) > 0.005) {
    throw new Error(`ScoringWeights must sum to 1.0 (got ${sum.toFixed(4)})`);
  }
  for (const [k, v] of Object.entries(w)) {
    if (v < 0 || v > 1) throw new Error(`Weight ${k} out of range: ${v}`);
  }
}

export function scoreGolfer(
  inputs: GolferScoringInputs,
  course: CourseProfile,
  weights: ScoringWeights,
): GolferSubscores {
  validateWeights(weights);

  const cf = scoreCourseFit(inputs.stats, course, inputs.owgrRank);
  const rf = scoreRecentForm(inputs.recentFinishes);
  const lt = scoreLongTerm(inputs.owgrRank);
  const ch = scoreCourseHistory(inputs.courseHistory, inputs.comparableHistory, rf.score);
  const cp = scoreCutProbability(inputs.datagolf, inputs.owgrRank, inputs.recentFinishes);
  const up = scoreUpside(inputs.stats, inputs.recentFinishes, rf.score);

  const composite =
      weights.courseFit       * cf.score
    + weights.recentForm      * rf.score
    + weights.longTerm        * lt.score
    + weights.courseHistory   * ch.score
    + weights.cutProbability  * cp.score
    + weights.upside          * up.score;

  // Dedup missing inputs (e.g. owgr_rank can be flagged by both CF and LT).
  const missingInputs = [...new Set([
    ...cf.missing, ...rf.missing, ...lt.missing,
    ...ch.missing, ...cp.missing, ...up.missing,
  ])];

  // Projected strokes to par: composite 50 = baseline scoring difficulty;
  // each composite point above 50 is worth ~0.1 strokes better.
  const diff = course.scoringDifficulty ?? 0;
  const projectedStrokesToPar = diff + (50 - composite) * 0.1;

  // Build a one-sentence explanation pulling the dominant signals.
  const explanation = buildExplanation(
    cf.score, rf.score, lt.score, ch.score, cp.score, up.score,
    missingInputs,
  );

  return {
    courseFit:      cf.score,
    recentForm:     rf.score,
    longTerm:       lt.score,
    courseHistory:  ch.score,
    cutProbability: cp.score,
    upside:         up.score,
    composite:      clamp(composite, 0, 100),
    missingInputs,
    projectedStrokesToPar,
    projectedCutProb: cp.rawProb,
    explanation,
  };
}

function buildExplanation(
  cf: number, rf: number, lt: number, ch: number, cp: number, up: number,
  missing: string[],
): string {
  const parts: string[] = [];
  if (cf >= 75) parts.push('strong course-fit profile');
  else if (cf <= 35) parts.push('weak course-fit profile');
  if (rf >= 75) parts.push('hot recent form');
  else if (rf <= 35) parts.push('cold recent form');
  if (ch >= 75) parts.push('strong history at this venue');
  else if (ch <= 35) parts.push('struggles at this venue');
  if (cp >= 85) parts.push('high cut-make probability');
  else if (cp <= 60) parts.push('cut-make risk');
  if (up >= 70) parts.push('upside ceiling');
  if (parts.length === 0) {
    parts.push(lt >= 70 ? 'top-ranked baseline' : 'middling baseline');
  }
  let s = parts.join(', ') + '.';
  if (missing.length > 0) s += ` (missing: ${missing.join(', ')})`;
  return s;
}
