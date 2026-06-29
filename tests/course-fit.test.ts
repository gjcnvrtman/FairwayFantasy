// Tests for src/lib/course-fit.ts — pure scoring math, no DB.
//
// Every input is allowed to be NULL per the spec; the scorer
// substitutes a proxy and records the field name in `missingInputs`.
// These tests pin both the happy-path subscore values AND every
// missing-input fallback path.

import { describe, it, expect } from 'vitest';
import {
  scoreGolfer,
  validateWeights,
  type GolferScoringInputs,
  type CourseProfile,
  type ScoringWeights,
  type Finish,
  type GolferStatRow,
  type DatagolfPredsRow,
} from '../src/lib/course-fit';

// ── Fixture builders ────────────────────────────────────────

const DEFAULT_WEIGHTS: ScoringWeights = {
  courseFit:      0.30,
  recentForm:     0.20,
  longTerm:       0.15,
  courseHistory:  0.15,
  cutProbability: 0.10,
  upside:         0.10,
};

function balancedCourse(): CourseProfile {
  return {
    scoringDifficulty:           0,
    drivingDistanceImportance:   0.25,
    drivingAccuracyImportance:   0.25,
    approachImportance:          0.25,
    aroundGreenImportance:       0.25,
    puttingImportance:           0.25,
  };
}

function approachHeavyCourse(): CourseProfile {
  return {
    scoringDifficulty:           1.5,
    drivingDistanceImportance:   0.10,
    drivingAccuracyImportance:   0.20,
    approachImportance:          0.50,
    aroundGreenImportance:       0.10,
    puttingImportance:           0.10,
  };
}

function eliteStats(): GolferStatRow {
  return {
    sg_total: 2.0,
    sg_ott:   0.5,
    sg_app:   1.0,
    sg_arg:   0.2,
    sg_putt:  0.3,
    driving_distance:     312,
    driving_accuracy_pct: 60,
    gir_pct:              73,
    scoring_avg:          69.5,
    birdie_avg:           4.7,
    bogey_avg:            2.1,
    made_cut_pct:         92,
  };
}

function midStats(): GolferStatRow {
  return {
    sg_total: 0.1,
    sg_ott:   0.0,
    sg_app:   0.1,
    sg_arg:   0.0,
    sg_putt:  0.0,
    driving_distance:     298,
    driving_accuracy_pct: 62,
    gir_pct:              66,
    scoring_avg:          70.5,
    birdie_avg:           3.8,
    bogey_avg:            2.9,
    made_cut_pct:         70,
  };
}

function recentTopFinishes(): Finish[] {
  // 6 events, mostly top-20.
  return [
    { position: 2,  missedCut: false, eventDate: '2026-06-22' },
    { position: 8,  missedCut: false, eventDate: '2026-06-15' },
    { position: 15, missedCut: false, eventDate: '2026-06-08' },
    { position: 4,  missedCut: false, eventDate: '2026-06-01' },
    { position: 22, missedCut: false, eventDate: '2026-05-25' },
    { position: 11, missedCut: false, eventDate: '2026-05-18' },
  ];
}

function recentColdFinishes(): Finish[] {
  return [
    { position: 999, missedCut: true,  eventDate: '2026-06-22' },
    { position: 65,  missedCut: false, eventDate: '2026-06-15' },
    { position: 999, missedCut: true,  eventDate: '2026-06-08' },
    { position: 999, missedCut: true,  eventDate: '2026-06-01' },
    { position: 55,  missedCut: false, eventDate: '2026-05-25' },
    { position: 999, missedCut: true,  eventDate: '2026-05-18' },
  ];
}

function emptyInputs(overrides: Partial<GolferScoringInputs> = {}): GolferScoringInputs {
  return {
    golferId:          'g-test',
    owgrRank:          null,
    stats:             null,
    datagolf:          null,
    recentFinishes:    [],
    courseHistory:     [],
    comparableHistory: [],
    ...overrides,
  };
}

// ── Weights validation ─────────────────────────────────────

describe('validateWeights', () => {
  it('accepts weights that sum to 1.0', () => {
    expect(() => validateWeights(DEFAULT_WEIGHTS)).not.toThrow();
  });

  it('rejects weights that sum < 1.0 by more than tolerance', () => {
    const bad = { ...DEFAULT_WEIGHTS, courseFit: 0.10 };
    expect(() => validateWeights(bad)).toThrow(/sum to 1\.0/);
  });

  it('rejects weights that sum > 1.0 by more than tolerance', () => {
    const bad = { ...DEFAULT_WEIGHTS, upside: 0.50 };
    expect(() => validateWeights(bad)).toThrow(/sum to 1\.0/);
  });

  it('accepts weights within ±0.005 of 1.0', () => {
    const close = { ...DEFAULT_WEIGHTS, courseFit: 0.301 };  // sums to 1.001
    expect(() => validateWeights(close)).not.toThrow();
  });

  it('rejects weights outside [0, 1]', () => {
    // sum stays = 1.0 (so the sum check passes) but courseFit is negative.
    // -0.10 + 0.60 + 0.15 + 0.15 + 0.10 + 0.10 = 1.00
    const bad = { ...DEFAULT_WEIGHTS, courseFit: -0.10, recentForm: 0.60 };
    expect(() => validateWeights(bad)).toThrow(/out of range/);
  });
});

// ── Composite happy path ───────────────────────────────────

describe('scoreGolfer — composite math', () => {
  it('elite golfer with all inputs scores high (>= 75)', () => {
    const out = scoreGolfer(
      emptyInputs({
        owgrRank: 3,
        stats: eliteStats(),
        datagolf: { win_prob: 0.06, top_5_prob: 0.22, top_10_prob: 0.35,
                    top_20_prob: 0.55, make_cut_prob: 0.93 },
        recentFinishes: recentTopFinishes(),
        courseHistory: recentTopFinishes().slice(0, 3),
        comparableHistory: [],
      }),
      approachHeavyCourse(),
      DEFAULT_WEIGHTS,
    );
    expect(out.composite).toBeGreaterThanOrEqual(75);
    expect(out.missingInputs).toEqual([]);
    expect(out.projectedCutProb).toBeCloseTo(0.93, 2);
  });

  it('cold mid-tier golfer with missing inputs scores low (<= 45)', () => {
    const out = scoreGolfer(
      emptyInputs({
        owgrRank: 150,
        stats: midStats(),
        datagolf: null,
        recentFinishes: recentColdFinishes(),
        courseHistory: [],
        comparableHistory: [],
      }),
      balancedCourse(),
      DEFAULT_WEIGHTS,
    );
    expect(out.composite).toBeLessThanOrEqual(45);
    expect(out.missingInputs).toContain('make_cut_prob');
    expect(out.missingInputs).toContain('course_history');
  });

  it('composite is clamped to [0, 100]', () => {
    const out = scoreGolfer(
      emptyInputs({ owgrRank: 1, stats: eliteStats() }),
      approachHeavyCourse(),
      DEFAULT_WEIGHTS,
    );
    expect(out.composite).toBeGreaterThanOrEqual(0);
    expect(out.composite).toBeLessThanOrEqual(100);
  });

  it('projectedStrokesToPar improves with composite (lower = better)', () => {
    const courseSimple = balancedCourse();
    const eliteOut = scoreGolfer(
      emptyInputs({
        owgrRank: 3, stats: eliteStats(), recentFinishes: recentTopFinishes(),
      }),
      courseSimple, DEFAULT_WEIGHTS,
    );
    const coldOut = scoreGolfer(
      emptyInputs({
        owgrRank: 150, stats: midStats(), recentFinishes: recentColdFinishes(),
      }),
      courseSimple, DEFAULT_WEIGHTS,
    );
    expect(eliteOut.projectedStrokesToPar).toBeLessThan(coldOut.projectedStrokesToPar);
  });
});

// ── Subscore: course fit ───────────────────────────────────

describe('course-fit subscore', () => {
  it('approach-heavy course rewards strong SG-APP', () => {
    const sgAppGolfer: GolferStatRow = {
      ...eliteStats(), sg_ott: 0, sg_arg: 0, sg_putt: 0, sg_app: 2.0,
    };
    const sgOttGolfer: GolferStatRow = {
      ...eliteStats(), sg_app: 0, sg_arg: 0, sg_putt: 0, sg_ott: 2.0,
    };
    const onApproachCourse = approachHeavyCourse();
    const a = scoreGolfer(emptyInputs({ owgrRank: 50, stats: sgAppGolfer }),
                          onApproachCourse, DEFAULT_WEIGHTS);
    const b = scoreGolfer(emptyInputs({ owgrRank: 50, stats: sgOttGolfer }),
                          onApproachCourse, DEFAULT_WEIGHTS);
    expect(a.courseFit).toBeGreaterThan(b.courseFit);
  });

  it('falls back to OWGR when stats are NULL', () => {
    const out = scoreGolfer(
      emptyInputs({ owgrRank: 10 }),
      balancedCourse(), DEFAULT_WEIGHTS,
    );
    expect(out.missingInputs).toContain('stats');
    expect(out.courseFit).toBeGreaterThan(80);  // rank 10 → close to 100
  });

  it('falls back to neutral 50 when both stats and OWGR are NULL', () => {
    const out = scoreGolfer(emptyInputs(), balancedCourse(), DEFAULT_WEIGHTS);
    expect(out.missingInputs).toContain('stats');
    expect(out.missingInputs).toContain('owgr_rank');
    expect(out.courseFit).toBe(50);
  });

  it('equal-weights the SG axes when course importances are all NULL', () => {
    const noImpCourse: CourseProfile = {
      scoringDifficulty: 0,
      drivingDistanceImportance: null,
      drivingAccuracyImportance: null,
      approachImportance: null,
      aroundGreenImportance: null,
      puttingImportance: null,
    };
    const out = scoreGolfer(
      emptyInputs({ stats: eliteStats() }),
      noImpCourse, DEFAULT_WEIGHTS,
    );
    expect(out.missingInputs).toContain('course_importance');
  });
});

// ── Subscore: recent form ──────────────────────────────────

describe('recent form subscore', () => {
  it('hot finishes give a high score', () => {
    const out = scoreGolfer(
      emptyInputs({ owgrRank: 50, recentFinishes: recentTopFinishes() }),
      balancedCourse(), DEFAULT_WEIGHTS,
    );
    expect(out.recentForm).toBeGreaterThanOrEqual(65);
  });

  it('cold finishes give a low score', () => {
    const out = scoreGolfer(
      emptyInputs({ owgrRank: 50, recentFinishes: recentColdFinishes() }),
      balancedCourse(), DEFAULT_WEIGHTS,
    );
    expect(out.recentForm).toBeLessThanOrEqual(30);
  });

  it('reports missing when no finishes available', () => {
    const out = scoreGolfer(emptyInputs(), balancedCourse(), DEFAULT_WEIGHTS);
    expect(out.missingInputs).toContain('recent_finishes');
    expect(out.recentForm).toBe(0);
  });

  it('weights most-recent finish more heavily', () => {
    // Identical MULTISET ({win, MC, MC, MC}); the win's POSITION changes.
    // When the win is at index 0 (most-recent), it carries the largest
    // weight; when the win is at index 3 (oldest), it carries the
    // smallest weight. Same set, different recency → recency wins.
    const winRecent: Finish[] = [
      { position: 1,   missedCut: false, eventDate: '2026-06-22' },
      { position: 999, missedCut: true,  eventDate: '2026-06-15' },
      { position: 999, missedCut: true,  eventDate: '2026-06-08' },
      { position: 999, missedCut: true,  eventDate: '2026-06-01' },
    ];
    const winOld: Finish[] = [
      { position: 999, missedCut: true,  eventDate: '2026-06-22' },
      { position: 999, missedCut: true,  eventDate: '2026-06-15' },
      { position: 999, missedCut: true,  eventDate: '2026-06-08' },
      { position: 1,   missedCut: false, eventDate: '2026-06-01' },
    ];
    const a = scoreGolfer(emptyInputs({ recentFinishes: winRecent }),
                          balancedCourse(), DEFAULT_WEIGHTS);
    const b = scoreGolfer(emptyInputs({ recentFinishes: winOld }),
                          balancedCourse(), DEFAULT_WEIGHTS);
    expect(a.recentForm).toBeGreaterThan(b.recentForm);
  });
});

// ── Subscore: long-term ────────────────────────────────────

describe('long-term subscore', () => {
  it('rank 1 = 100', () => {
    const out = scoreGolfer(emptyInputs({ owgrRank: 1 }),
                            balancedCourse(), DEFAULT_WEIGHTS);
    expect(out.longTerm).toBe(100);
  });

  it('rank 200 = 0', () => {
    const out = scoreGolfer(emptyInputs({ owgrRank: 200 }),
                            balancedCourse(), DEFAULT_WEIGHTS);
    expect(out.longTerm).toBe(0);
  });

  it('rank null falls back with missing flag', () => {
    const out = scoreGolfer(emptyInputs(), balancedCourse(), DEFAULT_WEIGHTS);
    expect(out.missingInputs).toContain('owgr_rank');
    expect(out.longTerm).toBe(25);
  });

  it('rank 100 ≈ 50', () => {
    const out = scoreGolfer(emptyInputs({ owgrRank: 100 }),
                            balancedCourse(), DEFAULT_WEIGHTS);
    expect(out.longTerm).toBeGreaterThan(45);
    expect(out.longTerm).toBeLessThan(55);
  });
});

// ── Subscore: course history ───────────────────────────────

describe('course history subscore', () => {
  it('uses course-specific history when present', () => {
    const out = scoreGolfer(
      emptyInputs({
        owgrRank: 30,
        courseHistory: [
          { position: 1, missedCut: false, eventDate: '2025-07-04' },
          { position: 3, missedCut: false, eventDate: '2024-07-05' },
        ],
        recentFinishes: recentColdFinishes(),
      }),
      balancedCourse(), DEFAULT_WEIGHTS,
    );
    expect(out.courseHistory).toBeGreaterThanOrEqual(90);
    expect(out.missingInputs).not.toContain('course_history');
  });

  it('falls back to comparable-course history with a discount', () => {
    const out = scoreGolfer(
      emptyInputs({
        owgrRank: 30,
        comparableHistory: [
          { position: 1, missedCut: false, eventDate: '2025-08-01' },
          { position: 5, missedCut: false, eventDate: '2024-08-01' },
        ],
      }),
      balancedCourse(), DEFAULT_WEIGHTS,
    );
    expect(out.missingInputs).toContain('course_history');
    expect(out.courseHistory).toBeGreaterThan(60);
    expect(out.courseHistory).toBeLessThan(95);   // discounted by × 0.9
  });

  it('falls back to recent-form × 0.8 when no history at all', () => {
    const out = scoreGolfer(
      emptyInputs({ recentFinishes: recentTopFinishes() }),
      balancedCourse(), DEFAULT_WEIGHTS,
    );
    expect(out.missingInputs).toContain('course_history');
    expect(out.missingInputs).toContain('comparable_history');
    expect(out.courseHistory).toBeCloseTo(out.recentForm * 0.8, 1);
  });
});

// ── Subscore: cut probability ──────────────────────────────

describe('cut probability subscore', () => {
  it('prefers Datagolf preds when present', () => {
    const dg: DatagolfPredsRow = {
      win_prob: 0.03, top_5_prob: 0.15, top_10_prob: 0.30, top_20_prob: 0.50,
      make_cut_prob: 0.88,
    };
    const out = scoreGolfer(
      emptyInputs({ owgrRank: 250, datagolf: dg }),  // bad OWGR
      balancedCourse(), DEFAULT_WEIGHTS,
    );
    expect(out.cutProbability).toBeCloseTo(88, 1);
    expect(out.projectedCutProb).toBeCloseTo(0.88, 2);
    expect(out.missingInputs).not.toContain('make_cut_prob');
  });

  it('derives from OWGR when Datagolf is missing', () => {
    const out = scoreGolfer(
      emptyInputs({ owgrRank: 10 }),
      balancedCourse(), DEFAULT_WEIGHTS,
    );
    expect(out.missingInputs).toContain('make_cut_prob');
    // top-10 OWGR → ≈90% (0.55 + 0.95 × 0.40)
    expect(out.projectedCutProb).toBeGreaterThan(0.85);
  });

  it('floors at 0.05 and caps at 0.99', () => {
    const out = scoreGolfer(emptyInputs(), balancedCourse(), DEFAULT_WEIGHTS);
    expect(out.projectedCutProb).toBeGreaterThanOrEqual(0.05);
    expect(out.projectedCutProb).toBeLessThanOrEqual(0.99);
  });

  it('blends recent made-cut rate when 3+ finishes available', () => {
    const allMc: Finish[] = Array.from({ length: 4 }, (_, i) => ({
      position: 999, missedCut: true, eventDate: `2026-06-${15 - i * 7}`,
    }));
    const out = scoreGolfer(
      emptyInputs({ owgrRank: 80, recentFinishes: allMc }),
      balancedCourse(), DEFAULT_WEIGHTS,
    );
    // 4 MCs should drag the probability down meaningfully.
    expect(out.projectedCutProb).toBeLessThan(0.65);
  });
});

// ── Subscore: upside ───────────────────────────────────────

describe('upside subscore', () => {
  it('elite ceiling + inconsistent recent form = high upside', () => {
    const inconsistent: Finish[] = [
      { position: 1,   missedCut: false, eventDate: '2026-06-22' },
      { position: 999, missedCut: true,  eventDate: '2026-06-15' },
      { position: 2,   missedCut: false, eventDate: '2026-06-08' },
      { position: 999, missedCut: true,  eventDate: '2026-06-01' },
    ];
    const out = scoreGolfer(
      emptyInputs({ owgrRank: 25, stats: eliteStats(), recentFinishes: inconsistent }),
      balancedCourse(), DEFAULT_WEIGHTS,
    );
    expect(out.upside).toBeGreaterThanOrEqual(65);
  });

  it('reports missing sg_total when stats are NULL', () => {
    const out = scoreGolfer(
      emptyInputs({ recentFinishes: recentTopFinishes() }),
      balancedCourse(), DEFAULT_WEIGHTS,
    );
    expect(out.missingInputs).toContain('sg_total');
  });
});

// ── Explanation ────────────────────────────────────────────

describe('explanation string', () => {
  it('includes "missing:" when any input is missing', () => {
    const out = scoreGolfer(emptyInputs(), balancedCourse(), DEFAULT_WEIGHTS);
    expect(out.explanation).toMatch(/missing:/);
  });

  it('omits missing tag when every input is present', () => {
    const out = scoreGolfer(
      emptyInputs({
        owgrRank: 5,
        stats: eliteStats(),
        datagolf: { win_prob: 0.05, top_5_prob: 0.20, top_10_prob: 0.35,
                    top_20_prob: 0.55, make_cut_prob: 0.92 },
        recentFinishes: recentTopFinishes(),
        courseHistory: recentTopFinishes().slice(0, 3),
      }),
      approachHeavyCourse(), DEFAULT_WEIGHTS,
    );
    expect(out.explanation).not.toMatch(/missing:/);
  });
});

// ── Determinism ────────────────────────────────────────────

describe('determinism', () => {
  it('same inputs produce identical output across calls', () => {
    const inputs = emptyInputs({
      owgrRank: 30, stats: eliteStats(),
      recentFinishes: recentTopFinishes(),
    });
    const course = approachHeavyCourse();
    const a = scoreGolfer(inputs, course, DEFAULT_WEIGHTS);
    const b = scoreGolfer(inputs, course, DEFAULT_WEIGHTS);
    expect(a).toEqual(b);
  });
});
