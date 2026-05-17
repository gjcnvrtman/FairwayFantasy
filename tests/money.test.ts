import { describe, it, expect } from 'vitest';
import {
  computeTournamentMoney,
  computeLeagueMoney,
  formatMoney,
} from '@/lib/money';

// ─────────────────────────────────────────────────────────────
// computeTournamentMoney — per-tournament dollar deltas
// ─────────────────────────────────────────────────────────────

describe('computeTournamentMoney — sole winner', () => {
  it('4-player league, $10 bet, sole winner wins $30; each loser loses $10', () => {
    const r = computeTournamentMoney({
      memberIds: ['u1', 'u2', 'u3', 'u4'],
      results: [
        { user_id: 'u1', rank: 1 },
        { user_id: 'u2', rank: 2 },
        { user_id: 'u3', rank: 3 },
        { user_id: 'u4', rank: 4 },
      ],
      betAmount: 10,
    });
    const byId = Object.fromEntries(r.map(d => [d.user_id, d.amount]));
    expect(byId.u1).toBe(30);
    expect(byId.u2).toBe(-10);
    expect(byId.u3).toBe(-10);
    expect(byId.u4).toBe(-10);
    expect(r.reduce((s, d) => s + d.amount, 0)).toBe(0); // money conserved
  });

  it('returns one delta per member id, preserving order', () => {
    const r = computeTournamentMoney({
      memberIds: ['a', 'b', 'c'],
      results: [
        { user_id: 'a', rank: 2 },
        { user_id: 'b', rank: 1 },
        { user_id: 'c', rank: 3 },
      ],
      betAmount: 5,
    });
    expect(r.map(d => d.user_id)).toEqual(['a', 'b', 'c']);
  });
});

describe('computeTournamentMoney — ties at #1 split the pot', () => {
  it('2-way tie in 4-player league: each winner +$10, each loser -$10', () => {
    const r = computeTournamentMoney({
      memberIds: ['u1', 'u2', 'u3', 'u4'],
      results: [
        { user_id: 'u1', rank: 1 },
        { user_id: 'u2', rank: 1 },   // tied
        { user_id: 'u3', rank: 3 },
        { user_id: 'u4', rank: 3 },
      ],
      betAmount: 10,
    });
    const byId = Object.fromEntries(r.map(d => [d.user_id, d.amount]));
    expect(byId.u1).toBe(10);  // pot=20 / 2 winners
    expect(byId.u2).toBe(10);
    expect(byId.u3).toBe(-10);
    expect(byId.u4).toBe(-10);
    expect(r.reduce((s, d) => s + d.amount, 0)).toBe(0);
  });

  it('3-way tie in 4-player league: each winner ≈+$3.33, one loser -$10', () => {
    const r = computeTournamentMoney({
      memberIds: ['u1', 'u2', 'u3', 'u4'],
      results: [
        { user_id: 'u1', rank: 1 },
        { user_id: 'u2', rank: 1 },
        { user_id: 'u3', rank: 1 },
        { user_id: 'u4', rank: 4 },
      ],
      betAmount: 10,
    });
    const byId = Object.fromEntries(r.map(d => [d.user_id, d.amount]));
    expect(byId.u1).toBeCloseTo(10 / 3, 4); // 3.3333…
    expect(byId.u2).toBeCloseTo(10 / 3, 4);
    expect(byId.u3).toBeCloseTo(10 / 3, 4);
    expect(byId.u4).toBe(-10);
    expect(r.reduce((s, d) => s + d.amount, 0)).toBeCloseTo(0, 4);
  });

  it('all members tied at #1: pot is 0 (no losers); each winner nets 0', () => {
    const r = computeTournamentMoney({
      memberIds: ['u1', 'u2'],
      results: [
        { user_id: 'u1', rank: 1 },
        { user_id: 'u2', rank: 1 },
      ],
      betAmount: 10,
    });
    const byId = Object.fromEntries(r.map(d => [d.user_id, d.amount]));
    expect(byId.u1).toBe(0);
    expect(byId.u2).toBe(0);
  });
});

describe('computeTournamentMoney — no-pick / null-rank handled as losers', () => {
  it('no-pick member (not in results) is treated as a loser', () => {
    // u4 didn't submit a pick — no row in results. Still owes the
    // bet because they joined the league.
    const r = computeTournamentMoney({
      memberIds: ['u1', 'u2', 'u3', 'u4'],
      results: [
        { user_id: 'u1', rank: 1 },
        { user_id: 'u2', rank: 2 },
        { user_id: 'u3', rank: 3 },
      ],
      betAmount: 10,
    });
    const byId = Object.fromEntries(r.map(d => [d.user_id, d.amount]));
    expect(byId.u1).toBe(30);  // 3 losers x $10
    expect(byId.u4).toBe(-10); // no-pick loser owes too
    expect(r.reduce((s, d) => s + d.amount, 0)).toBe(0);
  });

  it('null-rank member (all picks WD/DQ) is treated as a loser', () => {
    const r = computeTournamentMoney({
      memberIds: ['u1', 'u2'],
      results: [
        { user_id: 'u1', rank: 1 },
        { user_id: 'u2', rank: null }, // null rank — counted as loser
      ],
      betAmount: 10,
    });
    const byId = Object.fromEntries(r.map(d => [d.user_id, d.amount]));
    expect(byId.u1).toBe(10);
    expect(byId.u2).toBe(-10);
  });
});

describe('computeTournamentMoney — degenerate cases', () => {
  it('no winners (everyone null-rank or no-pick) → wash, all zeros', () => {
    const r = computeTournamentMoney({
      memberIds: ['u1', 'u2', 'u3'],
      results: [
        { user_id: 'u1', rank: null },
        // u2, u3 missing entirely
      ],
      betAmount: 10,
    });
    expect(r.every(d => d.amount === 0)).toBe(true);
  });

  it('1-member league: pot=0, no money changes', () => {
    const r = computeTournamentMoney({
      memberIds: ['solo'],
      results: [{ user_id: 'solo', rank: 1 }],
      betAmount: 10,
    });
    expect(r[0].amount).toBe(0);
  });

  it('0-dollar bet: math runs cleanly with all zeros', () => {
    const r = computeTournamentMoney({
      memberIds: ['u1', 'u2'],
      results: [
        { user_id: 'u1', rank: 1 },
        { user_id: 'u2', rank: 2 },
      ],
      betAmount: 0,
    });
    expect(r.every(d => d.amount === 0)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// computeLeagueMoney — sum across multiple tournaments
// ─────────────────────────────────────────────────────────────

describe('computeLeagueMoney', () => {
  it('sums per-user across multiple tournaments', () => {
    // Tournament 1: u1 wins  → +30, others -10 each
    // Tournament 2: u2 wins  → +30, others -10 each
    // Tournament 3: u1+u2 tie → +10 each, u3+u4 -10 each
    const r = computeLeagueMoney({
      memberIds: ['u1', 'u2', 'u3', 'u4'],
      tournaments: [
        {
          memberIds: [],   // overwritten by computeLeagueMoney
          betAmount: 10,
          results: [
            { user_id: 'u1', rank: 1 }, { user_id: 'u2', rank: 2 },
            { user_id: 'u3', rank: 3 }, { user_id: 'u4', rank: 4 },
          ],
        },
        {
          memberIds: [],
          betAmount: 10,
          results: [
            { user_id: 'u1', rank: 2 }, { user_id: 'u2', rank: 1 },
            { user_id: 'u3', rank: 3 }, { user_id: 'u4', rank: 4 },
          ],
        },
        {
          memberIds: [],
          betAmount: 10,
          results: [
            { user_id: 'u1', rank: 1 }, { user_id: 'u2', rank: 1 },
            { user_id: 'u3', rank: 3 }, { user_id: 'u4', rank: 4 },
          ],
        },
      ],
    });
    const byId = Object.fromEntries(r.totals.map(d => [d.user_id, d.amount]));
    expect(byId.u1).toBe(30 + (-10) + 10);  // +30
    expect(byId.u2).toBe((-10) + 30 + 10);  // +30
    expect(byId.u3).toBe((-10) + (-10) + (-10)); // -30
    expect(byId.u4).toBe((-10) + (-10) + (-10)); // -30
    // Money conserved across the entire league window:
    expect(r.totals.reduce((s, d) => s + d.amount, 0)).toBe(0);
    expect(r.byTournament).toHaveLength(3);
  });

  it('handles a no-pick user across multiple tournaments', () => {
    // u3 never submitted; should lose every tournament.
    const r = computeLeagueMoney({
      memberIds: ['u1', 'u2', 'u3'],
      tournaments: [
        {
          memberIds: [], betAmount: 10,
          results: [{ user_id: 'u1', rank: 1 }, { user_id: 'u2', rank: 2 }],
        },
        {
          memberIds: [], betAmount: 10,
          results: [{ user_id: 'u2', rank: 1 }, { user_id: 'u1', rank: 2 }],
        },
      ],
    });
    const byId = Object.fromEntries(r.totals.map(d => [d.user_id, d.amount]));
    expect(byId.u3).toBe(-20); // -10 × 2 tournaments
  });

  it('empty tournament list returns zero totals for every member', () => {
    const r = computeLeagueMoney({
      memberIds: ['u1', 'u2'],
      tournaments: [],
    });
    expect(r.totals).toEqual([
      { user_id: 'u1', amount: 0 },
      { user_id: 'u2', amount: 0 },
    ]);
    expect(r.byTournament).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// formatMoney — display helper
// ─────────────────────────────────────────────────────────────

describe('formatMoney', () => {
  it('formats positives with + sign', () => {
    expect(formatMoney(30)).toBe('+$30.00');
    expect(formatMoney(3.33)).toBe('+$3.33');
  });
  it('formats negatives with - sign', () => {
    expect(formatMoney(-10)).toBe('-$10.00');
    expect(formatMoney(-3.5)).toBe('-$3.50');
  });
  it('formats exact zero without sign', () => {
    expect(formatMoney(0)).toBe('$0.00');
  });
  it('always 2 decimals', () => {
    expect(formatMoney(7)).toBe('+$7.00');
  });
});
