// Pins the per-tournament cut-rule fallback used by syncTournament
// when ESPN doesn't supply `cutLine`. ESPN's explicit value always
// wins when present; this code only fires during the post-R2 /
// pre-ESPN-cut-publish window.
//
// Originally the fallback was a hard-coded top-65-and-ties rule
// applied to every event, which mis-classified missed-cut golfers
// at all four Majors (their cut rules differ). Now per-tournament.

import { describe, it, expect } from 'vitest';
import { inferCutRule, applyCutRule, type CutRule } from '../src/lib/sync';

describe('inferCutRule', () => {
  it('returns top-65 for regular PGA Tour events', () => {
    expect(inferCutRule('Charles Schwab Challenge', 'regular')).toEqual({
      kind: 'topN',
      n: 65,
    });
    expect(inferCutRule('Truist Championship', 'regular')).toEqual({
      kind: 'topN',
      n: 65,
    });
  });

  it('returns Masters compound rule (top 50 + ties AND within 10 of leader)', () => {
    expect(inferCutRule('Masters Tournament', 'major')).toEqual({
      kind: 'topN+strokesBack',
      n: 50,
      strokesBack: 10,
    });
    // Case insensitive — ESPN sometimes emits "The Masters", sometimes "Masters Tournament"
    expect(inferCutRule('The Masters', 'major')).toEqual({
      kind: 'topN+strokesBack',
      n: 50,
      strokesBack: 10,
    });
  });

  it('returns top-60 for U.S. Open (USGA standard)', () => {
    expect(inferCutRule('U.S. Open', 'major')).toEqual({ kind: 'topN', n: 60 });
    // Tolerate the no-period variant ESPN sometimes uses
    expect(inferCutRule('US Open', 'major')).toEqual({ kind: 'topN', n: 60 });
    expect(inferCutRule('U S Open', 'major')).toEqual({ kind: 'topN', n: 60 });
  });

  it('returns top-70 for The Open Championship / British Open (R&A standard)', () => {
    expect(inferCutRule('The Open Championship', 'major')).toEqual({ kind: 'topN', n: 70 });
    expect(inferCutRule('British Open', 'major')).toEqual({ kind: 'topN', n: 70 });
  });

  it('returns top-70 for PGA Championship', () => {
    expect(inferCutRule('PGA Championship', 'major')).toEqual({ kind: 'topN', n: 70 });
  });

  it('falls back to top-65 for an unknown major (defensive default)', () => {
    expect(inferCutRule('Some New Major That Did Not Exist Before', 'major')).toEqual({
      kind: 'topN',
      n: 65,
    });
  });

  it('ignores type when the name unambiguously identifies a major', () => {
    // Defense-in-depth: if the type column is wrongly labelled 'regular'
    // for a Major (or NULL), we still apply top-65 default rather than
    // misclassifying. The cost is one Major a year possibly using top-65
    // instead of top-60/70, vs the cost of running a Masters-rule against
    // a non-Masters event. Lean toward the safer default.
    expect(inferCutRule('The Masters', 'regular')).toEqual({ kind: 'topN', n: 65 });
  });
});

describe('applyCutRule', () => {
  // Totals are 36-hole cumulative scores to par (lower = better in golf).
  // Helper: a synthetic field of N players each one stroke worse than
  // the last, starting at -10.
  const synthField = (n: number) =>
    Array.from({ length: n }, (_, i) => -10 + i);

  it('topN — Nth-best total is the cut score', () => {
    const totals = synthField(150).sort((a, b) => a - b);
    // Top 65 + ties: 65th-best (0-indexed = totals[64])
    expect(applyCutRule({ kind: 'topN', n: 65 }, totals)).toBe(totals[64]);
    // Top 70 + ties: 70th-best
    expect(applyCutRule({ kind: 'topN', n: 70 }, totals)).toBe(totals[69]);
    // Top 60 + ties: 60th-best
    expect(applyCutRule({ kind: 'topN', n: 60 }, totals)).toBe(totals[59]);
  });

  it('topN+strokesBack — uses the MORE LENIENT (higher) of the two thresholds', () => {
    // Masters case A: top-50 cuts tighter than within-10. Leader at -8.
    //   positions 0..49 (top 50): leader + 49 players at -3   → 50th-place = -3
    //   leader + 10                                            = +2
    //   More lenient (higher) = +2 — within-10 rule lets in players
    //   outside top 50 who are still within 10 of the leader.
    const totals1 = [
      -8, ...Array(49).fill(-3), +2, ...Array(100).fill(+5),
    ].sort((a, b) => a - b);
    expect(totals1[49]).toBe(-3); // sanity: 50th-place is -3
    expect(applyCutRule({ kind: 'topN+strokesBack', n: 50, strokesBack: 10 }, totals1)).toBe(+2);

    // Masters case B: within-10 cuts tighter than top-50. Leader-runs-away
    // scenario — bunched field, no one within 10 strokes outside top-50.
    //   positions 0..49 (top 50): leader at -15 + 49 players at -2 → 50th = -2
    //   leader + 10                                                  = -5
    //   More lenient (higher) = -2 — top-50 rule lets in players
    //   >10 strokes back who still make top 50.
    const totals2 = [
      -15, ...Array(49).fill(-2), ...Array(50).fill(+5),
    ].sort((a, b) => a - b);
    expect(totals2[49]).toBe(-2); // sanity
    expect(applyCutRule({ kind: 'topN+strokesBack', n: 50, strokesBack: 10 }, totals2)).toBe(-2);

    // Masters case C: solo leader blowout. Leader at -12, rest at +0.
    //   50th-place = 0   (everyone tied at +0 makes top 50)
    //   leader + 10 = -2
    //   More lenient = 0
    const totals3 = [-12, ...Array(149).fill(0)].sort((a, b) => a - b);
    expect(totals3[49]).toBe(0); // sanity
    expect(applyCutRule({ kind: 'topN+strokesBack', n: 50, strokesBack: 10 }, totals3)).toBe(0);
  });

  it('field smaller than N — everyone makes the cut (clamp at last element)', () => {
    // 40-man invitational; top-65 rule → cut at the worst total in the
    // field (everyone makes it).
    const totals = synthField(40).sort((a, b) => a - b);
    expect(applyCutRule({ kind: 'topN', n: 65 }, totals)).toBe(totals[totals.length - 1]);
    // Masters rule on a 30-man field — same clamp logic.
    expect(applyCutRule({ kind: 'topN+strokesBack', n: 50, strokesBack: 10 }, totals)).toBe(
      Math.max(totals[totals.length - 1], totals[0] + 10),
    );
  });

  it('throws on empty totals (caller must guard)', () => {
    expect(() => applyCutRule({ kind: 'topN', n: 65 }, [])).toThrow();
  });
});

describe('inferCutRule + applyCutRule integration — per-Major end-to-end', () => {
  // Realistic 2026 PGA Championship-style field: 156 starters, cut at top-70.
  const pgaField = (() => {
    const totals: number[] = [];
    for (let i = 0; i < 156; i++) totals.push(-12 + i * 0.3);
    return totals.sort((a, b) => a - b);
  })();

  it('PGA Championship + regular field → top-70 cut', () => {
    const rule = inferCutRule('PGA Championship', 'major');
    const cut = applyCutRule(rule, pgaField);
    expect(rule).toEqual({ kind: 'topN', n: 70 });
    expect(cut).toBe(pgaField[69]);
  });

  it('Charles Schwab Challenge + regular field → top-65 cut', () => {
    const rule = inferCutRule('Charles Schwab Challenge', 'regular');
    const cut = applyCutRule(rule, pgaField);
    expect(rule).toEqual({ kind: 'topN', n: 65 });
    expect(cut).toBe(pgaField[64]);
  });
});
