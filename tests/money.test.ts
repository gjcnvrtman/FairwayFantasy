import { describe, it, expect } from 'vitest';
import {
  computeTournamentMoney,
  computeLeagueMoney,
  formatMoney,
} from '@/lib/money';

// All baseline-everyone-eligible tests use a single shared lock time;
// members all "joined" before it so the new joined_at filter is a
// no-op and the math matches the pre-filter behaviour.
const BEFORE_LOCK = '2026-01-01T00:00:00Z';
const LOCK_TIME   = '2026-05-01T00:00:00Z';
const AFTER_LOCK  = '2026-05-15T00:00:00Z';

function mk(ids: string[], joined: string | Date = BEFORE_LOCK) {
  return ids.map(user_id => ({ user_id, joined_at: joined }));
}

// ─────────────────────────────────────────────────────────────
// computeTournamentMoney — per-tournament dollar deltas
// ─────────────────────────────────────────────────────────────

describe('computeTournamentMoney — sole winner', () => {
  it('4-player league, $10 bet, sole winner wins $30; each loser loses $10', () => {
    const r = computeTournamentMoney({
      members:  mk(['u1', 'u2', 'u3', 'u4']),
      lockedAt: LOCK_TIME,
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

  it('returns one delta per member, preserving order', () => {
    const r = computeTournamentMoney({
      members:  mk(['a', 'b', 'c']),
      lockedAt: LOCK_TIME,
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
      members:  mk(['u1', 'u2', 'u3', 'u4']),
      lockedAt: LOCK_TIME,
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
      members:  mk(['u1', 'u2', 'u3', 'u4']),
      lockedAt: LOCK_TIME,
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
      members:  mk(['u1', 'u2']),
      lockedAt: LOCK_TIME,
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
    const r = computeTournamentMoney({
      members:  mk(['u1', 'u2', 'u3', 'u4']),
      lockedAt: LOCK_TIME,
      results: [
        { user_id: 'u1', rank: 1 },
        { user_id: 'u2', rank: 2 },
        { user_id: 'u3', rank: 3 },
      ],
      betAmount: 10,
    });
    const byId = Object.fromEntries(r.map(d => [d.user_id, d.amount]));
    expect(byId.u1).toBe(30);
    expect(byId.u4).toBe(-10);
    expect(r.reduce((s, d) => s + d.amount, 0)).toBe(0);
  });

  it('null-rank member (all picks WD/DQ) is treated as a loser', () => {
    const r = computeTournamentMoney({
      members:  mk(['u1', 'u2']),
      lockedAt: LOCK_TIME,
      results: [
        { user_id: 'u1', rank: 1 },
        { user_id: 'u2', rank: null },
      ],
      betAmount: 10,
    });
    const byId = Object.fromEntries(r.map(d => [d.user_id, d.amount]));
    expect(byId.u1).toBe(10);
    expect(byId.u2).toBe(-10);
  });
});

describe('computeTournamentMoney — late-joiner exclusion (Greg 2026-05-17)', () => {
  it('member who joined AFTER lockedAt gets $0 regardless of result', () => {
    // u1, u2, u3 were in the league when picks locked.
    // u4 joined LATER (joined_at > lockedAt). u1 wins. The pot is
    // 2 losers × $10 = $20, NOT 3 × $10 — u4 is invisible to the math.
    const r = computeTournamentMoney({
      members: [
        { user_id: 'u1', joined_at: BEFORE_LOCK },
        { user_id: 'u2', joined_at: BEFORE_LOCK },
        { user_id: 'u3', joined_at: BEFORE_LOCK },
        { user_id: 'u4', joined_at: AFTER_LOCK },
      ],
      lockedAt: LOCK_TIME,
      results: [
        { user_id: 'u1', rank: 1 },
        { user_id: 'u2', rank: 2 },
        { user_id: 'u3', rank: 3 },
      ],
      betAmount: 10,
    });
    const byId = Object.fromEntries(r.map(d => [d.user_id, d.amount]));
    expect(byId.u1).toBe(20);   // 2 losers × $10 (not 3)
    expect(byId.u2).toBe(-10);
    expect(byId.u3).toBe(-10);
    expect(byId.u4).toBe(0);    // late joiner — wasn't in the bet
    expect(r.reduce((s, d) => s + d.amount, 0)).toBe(0);
  });

  it('member who joined exactly AT lockedAt is included (≤ not <)', () => {
    const r = computeTournamentMoney({
      members: [
        { user_id: 'u1', joined_at: BEFORE_LOCK },
        { user_id: 'u2', joined_at: LOCK_TIME },  // joined at the boundary
      ],
      lockedAt: LOCK_TIME,
      results: [
        { user_id: 'u1', rank: 1 },
        { user_id: 'u2', rank: 2 },
      ],
      betAmount: 10,
    });
    const byId = Object.fromEntries(r.map(d => [d.user_id, d.amount]));
    expect(byId.u1).toBe(10);
    expect(byId.u2).toBe(-10);
  });

  it('all members joined after lockedAt → wash, all zeros', () => {
    const r = computeTournamentMoney({
      members:  mk(['u1', 'u2'], AFTER_LOCK),
      lockedAt: LOCK_TIME,
      results: [
        { user_id: 'u1', rank: 1 },
        { user_id: 'u2', rank: 2 },
      ],
      betAmount: 10,
    });
    expect(r.every(d => d.amount === 0)).toBe(true);
  });

  it('accepts Date objects for both joined_at and lockedAt', () => {
    const r = computeTournamentMoney({
      members: [
        { user_id: 'u1', joined_at: new Date(BEFORE_LOCK) },
        { user_id: 'u2', joined_at: new Date(AFTER_LOCK) },
      ],
      lockedAt: new Date(LOCK_TIME),
      results: [{ user_id: 'u1', rank: 1 }],
      betAmount: 10,
    });
    const byId = Object.fromEntries(r.map(d => [d.user_id, d.amount]));
    expect(byId.u1).toBe(0);   // sole eligible member, no losers, pot = 0
    expect(byId.u2).toBe(0);   // late joiner
  });
});

describe('computeTournamentMoney — degenerate cases', () => {
  it('no winners (everyone null-rank or no-pick) → wash, all zeros', () => {
    const r = computeTournamentMoney({
      members:  mk(['u1', 'u2', 'u3']),
      lockedAt: LOCK_TIME,
      results: [
        { user_id: 'u1', rank: null },
      ],
      betAmount: 10,
    });
    expect(r.every(d => d.amount === 0)).toBe(true);
  });

  it('1-member league: pot=0, no money changes', () => {
    const r = computeTournamentMoney({
      members:  mk(['solo']),
      lockedAt: LOCK_TIME,
      results: [{ user_id: 'solo', rank: 1 }],
      betAmount: 10,
    });
    expect(r[0].amount).toBe(0);
  });

  it('0-dollar bet: math runs cleanly with all zeros', () => {
    const r = computeTournamentMoney({
      members:  mk(['u1', 'u2']),
      lockedAt: LOCK_TIME,
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
    const r = computeLeagueMoney({
      members: mk(['u1', 'u2', 'u3', 'u4']),
      tournaments: [
        {
          lockedAt:  LOCK_TIME, betAmount: 10,
          results: [
            { user_id: 'u1', rank: 1 }, { user_id: 'u2', rank: 2 },
            { user_id: 'u3', rank: 3 }, { user_id: 'u4', rank: 4 },
          ],
        },
        {
          lockedAt:  LOCK_TIME, betAmount: 10,
          results: [
            { user_id: 'u1', rank: 2 }, { user_id: 'u2', rank: 1 },
            { user_id: 'u3', rank: 3 }, { user_id: 'u4', rank: 4 },
          ],
        },
        {
          lockedAt:  LOCK_TIME, betAmount: 10,
          results: [
            { user_id: 'u1', rank: 1 }, { user_id: 'u2', rank: 1 },
            { user_id: 'u3', rank: 3 }, { user_id: 'u4', rank: 4 },
          ],
        },
      ],
    });
    const byId = Object.fromEntries(r.totals.map(d => [d.user_id, d.amount]));
    expect(byId.u1).toBe(30 + (-10) + 10);
    expect(byId.u2).toBe((-10) + 30 + 10);
    expect(byId.u3).toBe((-10) + (-10) + (-10));
    expect(byId.u4).toBe((-10) + (-10) + (-10));
    expect(r.totals.reduce((s, d) => s + d.amount, 0)).toBe(0);
    expect(r.byTournament).toHaveLength(3);
  });

  it('honors per-tournament betAmount (overrides shipped 2026-06-06)', () => {
    // T1 keeps the league default $10; T2 has an admin-set override of
    // $25. computeLeagueMoney should compute pots independently per
    // tournament, not blend them.
    const r = computeLeagueMoney({
      members: mk(['u1', 'u2', 'u3', 'u4']),
      tournaments: [
        {
          lockedAt:  LOCK_TIME, betAmount: 10,            // league default
          results: [
            { user_id: 'u1', rank: 1 }, { user_id: 'u2', rank: 2 },
            { user_id: 'u3', rank: 3 }, { user_id: 'u4', rank: 4 },
          ],
        },
        {
          lockedAt:  LOCK_TIME, betAmount: 25,            // overridden
          results: [
            { user_id: 'u2', rank: 1 }, { user_id: 'u1', rank: 2 },
            { user_id: 'u3', rank: 3 }, { user_id: 'u4', rank: 4 },
          ],
        },
      ],
    });
    const byId = Object.fromEntries(r.totals.map(d => [d.user_id, d.amount]));
    // T1: u1 wins pot of 3×$10=$30; losers each pay $10.
    // T2: u2 wins pot of 3×$25=$75; losers each pay $25.
    expect(byId.u1).toBe(30 + (-25));   // +5
    expect(byId.u2).toBe(-10 + 75);     // +65
    expect(byId.u3).toBe(-10 + -25);    // -35
    expect(byId.u4).toBe(-10 + -25);    // -35
    expect(r.totals.reduce((s, d) => s + d.amount, 0)).toBe(0);
    // Per-tournament breakdown reflects the per-tournament pot, not
    // a blended one.
    expect(r.byTournament[0].find(d => d.user_id === 'u1')?.amount).toBe(30);
    expect(r.byTournament[1].find(d => d.user_id === 'u2')?.amount).toBe(75);
  });

  it('handles a no-pick user across multiple tournaments', () => {
    const r = computeLeagueMoney({
      members: mk(['u1', 'u2', 'u3']),
      tournaments: [
        {
          lockedAt:  LOCK_TIME, betAmount: 10,
          results: [{ user_id: 'u1', rank: 1 }, { user_id: 'u2', rank: 2 }],
        },
        {
          lockedAt:  LOCK_TIME, betAmount: 10,
          results: [{ user_id: 'u2', rank: 1 }, { user_id: 'u1', rank: 2 }],
        },
      ],
    });
    const byId = Object.fromEntries(r.totals.map(d => [d.user_id, d.amount]));
    expect(byId.u3).toBe(-20); // -10 × 2 tournaments
  });

  it('a late-joining user owes $0 on tournaments before they joined', () => {
    // u3 joined AFTER Tournament 1's lockedAt but before Tournament 2's.
    // T1: u3 invisible → pot = 1 × $10 between u1, u2
    // T2: u3 in → pot = 2 × $10 between u1, u2, u3
    const r = computeLeagueMoney({
      members: [
        { user_id: 'u1', joined_at: '2026-01-01T00:00:00Z' },
        { user_id: 'u2', joined_at: '2026-01-01T00:00:00Z' },
        { user_id: 'u3', joined_at: '2026-05-10T00:00:00Z' },  // late
      ],
      tournaments: [
        {
          lockedAt:  '2026-05-01T00:00:00Z', betAmount: 10,
          results: [{ user_id: 'u1', rank: 1 }, { user_id: 'u2', rank: 2 }],
        },
        {
          lockedAt:  '2026-05-14T00:00:00Z', betAmount: 10,
          results: [
            { user_id: 'u1', rank: 1 },
            { user_id: 'u2', rank: 2 },
            { user_id: 'u3', rank: 3 },
          ],
        },
      ],
    });
    const byId = Object.fromEntries(r.totals.map(d => [d.user_id, d.amount]));
    // T1: u1 +10, u2 -10, u3 0
    // T2: u1 +20, u2 -10, u3 -10
    expect(byId.u1).toBe(30);
    expect(byId.u2).toBe(-20);
    expect(byId.u3).toBe(-10);
  });

  it('empty tournament list returns zero totals for every member', () => {
    const r = computeLeagueMoney({
      members: mk(['u1', 'u2']),
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
