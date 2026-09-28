import { describe, it, expect } from 'vitest';
import {
  computeTournamentMoney,
  computeLeagueMoney,
  formatMoney,
  PAYOUT_WINNER_TAKE_ALL,
  resolveTournamentBet,
  type PayoutStructure,
} from '@/lib/money';

describe('resolveTournamentBet — override > majors > weekly (migration 025)', () => {
  it('regular event uses weekly', () => {
    expect(resolveTournamentBet({ override: null, isMajor: false, weekly: 10, major: 25 })).toBe(10);
  });
  it('major uses majors bet when set', () => {
    expect(resolveTournamentBet({ override: null, isMajor: true, weekly: 10, major: 25 })).toBe(25);
  });
  it('major falls back to weekly when no majors bet', () => {
    expect(resolveTournamentBet({ override: undefined, isMajor: true, weekly: 10, major: null })).toBe(10);
  });
  it('per-tournament override wins over both (pre-025 leagues)', () => {
    expect(resolveTournamentBet({ override: 5, isMajor: true, weekly: 10, major: 25 })).toBe(5);
  });
  it('override of 0 is honored (free week), not treated as missing', () => {
    expect(resolveTournamentBet({ override: 0, isMajor: false, weekly: 10, major: null })).toBe(0);
  });
});

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

// ─────────────────────────────────────────────────────────────
// Top-3 payout structures — migration 023.
//
// Under the new algorithm each eligible member antes betAmount and
// the pot (eligible × betAmount) splits across the top 3 finishers
// per `payout`. Ties resolve by the PGA combined-share rule.
//
// With payout = PAYOUT_WINNER_TAKE_ALL (100/0/0), results match the
// legacy "loser pool distributed to rank-1" model (all baseline
// tests above use the default and still pass).
// ─────────────────────────────────────────────────────────────

const P_50_30_20: PayoutStructure = { pct1: 50, pct2: 30, pct3: 20 };
const P_60_30_10: PayoutStructure = { pct1: 60, pct2: 30, pct3: 10 };

describe('computeTournamentMoney — 50/30/20 with no ties', () => {
  it('10 members $10 ante — rank1 +$40, rank2 +$20, rank3 +$10, rank4-10 -$10', () => {
    const r = computeTournamentMoney({
      members: mk(['u1','u2','u3','u4','u5','u6','u7','u8','u9','u10']),
      lockedAt: LOCK_TIME,
      results: Array.from({ length: 10 }, (_, i) => ({
        user_id: `u${i + 1}`, rank: i + 1,
      })),
      betAmount: 10,
      payout: P_50_30_20,
    });
    const byId = Object.fromEntries(r.map(d => [d.user_id, d.amount]));
    // pot = 10 × $10 = $100. Gross: r1=$50, r2=$30, r3=$20. Net = gross - $10 ante.
    expect(byId.u1).toBe(40);
    expect(byId.u2).toBe(20);
    expect(byId.u3).toBe(10);
    for (let i = 4; i <= 10; i++) expect(byId[`u${i}`]).toBe(-10);
    // Money conserved.
    expect(r.reduce((s, d) => s + d.amount, 0)).toBe(0);
  });
});

describe('computeTournamentMoney — PGA tie rule at rank 1', () => {
  it('2-way tie at 1 (K=2) → they split combined pct_1+pct_2, no rank-3 payout to them', () => {
    // 10 members, $10 ante, pot=$100. K=2 tied at 1 occupy ranks 1&2.
    // Combined = 50+30 = 80%. Each gets $40 gross. Rank 3 (u3) still
    // gets pct_3 = 20% = $20 gross. Everyone else pays $10.
    const results = [
      { user_id: 'u1', rank: 1 },
      { user_id: 'u2', rank: 1 },
      { user_id: 'u3', rank: 3 },  // rank 2 is consumed by the tie
      ...Array.from({ length: 7 }, (_, i) => ({
        user_id: `u${i + 4}`, rank: i + 4,
      })),
    ];
    const r = computeTournamentMoney({
      members: mk(results.map(x => x.user_id)),
      lockedAt: LOCK_TIME,
      results,
      betAmount: 10,
      payout: P_50_30_20,
    });
    const byId = Object.fromEntries(r.map(d => [d.user_id, d.amount]));
    expect(byId.u1).toBe(30);   // 40 gross - 10 ante
    expect(byId.u2).toBe(30);
    expect(byId.u3).toBe(10);   // 20 gross - 10 ante
    for (let i = 4; i <= 10; i++) expect(byId[`u${i}`]).toBe(-10);
    expect(r.reduce((s, d) => s + d.amount, 0)).toBeCloseTo(0, 10);
  });

  it('3-way tie at 1 (K=3) → they split all three shares (100%) equally', () => {
    // 10 members. K=3 at rank 1 occupy 1/2/3. Combined = 100%.
    // Each of the 3 gets $100/3 ≈ $33.33 gross, net ≈ $23.33.
    const results = [
      { user_id: 'u1', rank: 1 }, { user_id: 'u2', rank: 1 }, { user_id: 'u3', rank: 1 },
      ...Array.from({ length: 7 }, (_, i) => ({
        user_id: `u${i + 4}`, rank: i + 4,
      })),
    ];
    const r = computeTournamentMoney({
      members: mk(results.map(x => x.user_id)),
      lockedAt: LOCK_TIME, results, betAmount: 10, payout: P_50_30_20,
    });
    const byId = Object.fromEntries(r.map(d => [d.user_id, d.amount]));
    const expectedGross = 100 / 3;
    expect(byId.u1).toBeCloseTo(expectedGross - 10, 10);
    expect(byId.u2).toBeCloseTo(expectedGross - 10, 10);
    expect(byId.u3).toBeCloseTo(expectedGross - 10, 10);
    for (let i = 4; i <= 10; i++) expect(byId[`u${i}`]).toBe(-10);
    // Rank 1 wins consume ranks 1-3, so no other paid ranks.
    expect(r.reduce((s, d) => s + d.amount, 0)).toBeCloseTo(0, 10);
  });

  it('4-way tie at 1 (K=4) → only ranks 1..3 pay, 4th tied gets pct_4 = 0 in the combined pool', () => {
    // K=4 at rank 1 occupy 1/2/3/4. Combined = 50+30+20+0 = 100%.
    // Each of the 4 gets $25 gross, net $15. Ranks 5+ pay ante.
    const results = [
      { user_id: 'u1', rank: 1 }, { user_id: 'u2', rank: 1 },
      { user_id: 'u3', rank: 1 }, { user_id: 'u4', rank: 1 },
      ...Array.from({ length: 6 }, (_, i) => ({
        user_id: `u${i + 5}`, rank: i + 5,
      })),
    ];
    const r = computeTournamentMoney({
      members: mk(results.map(x => x.user_id)),
      lockedAt: LOCK_TIME, results, betAmount: 10, payout: P_50_30_20,
    });
    const byId = Object.fromEntries(r.map(d => [d.user_id, d.amount]));
    for (let i = 1; i <= 4; i++) expect(byId[`u${i}`]).toBe(15);
    for (let i = 5; i <= 10; i++) expect(byId[`u${i}`]).toBe(-10);
    expect(r.reduce((s, d) => s + d.amount, 0)).toBeCloseTo(0, 10);
  });
});

describe('computeTournamentMoney — PGA tie rule at rank 2', () => {
  it('2-way tie at 2 (K=2) → they split combined pct_2+pct_3, rank 1 gets pct_1', () => {
    const results = [
      { user_id: 'u1', rank: 1 },
      { user_id: 'u2', rank: 2 }, { user_id: 'u3', rank: 2 },
      ...Array.from({ length: 7 }, (_, i) => ({
        user_id: `u${i + 4}`, rank: i + 4,  // rank 3 skipped by tie
      })),
    ];
    const r = computeTournamentMoney({
      members: mk(results.map(x => x.user_id)),
      lockedAt: LOCK_TIME, results, betAmount: 10, payout: P_50_30_20,
    });
    const byId = Object.fromEntries(r.map(d => [d.user_id, d.amount]));
    // Rank 1: 50% × $100 = $50 gross, net +$40.
    // Tied at 2: (30+20)/2 = 25% each × $100 = $25 gross, net +$15.
    expect(byId.u1).toBe(40);
    expect(byId.u2).toBe(15);
    expect(byId.u3).toBe(15);
    for (let i = 4; i <= 10; i++) expect(byId[`u${i}`]).toBe(-10);
    expect(r.reduce((s, d) => s + d.amount, 0)).toBeCloseTo(0, 10);
  });

  it('5-way tie at 2 (K=5, like FedEx St. Jude 2026) → combined pct_2+pct_3 split 5 ways', () => {
    // Occupies ranks 2..6. Combined = 30+20+0+0+0 = 50%.
    // Each tied player gets 50/5 = 10% × $100 = $10 gross, net $0.
    const results = [
      { user_id: 'u1', rank: 1 },
      ...['u2','u3','u4','u5','u6'].map(id => ({ user_id: id, rank: 2 })),
      ...Array.from({ length: 4 }, (_, i) => ({
        user_id: `u${i + 7}`, rank: i + 7,
      })),
    ];
    const r = computeTournamentMoney({
      members: mk(results.map(x => x.user_id)),
      lockedAt: LOCK_TIME, results, betAmount: 10, payout: P_50_30_20,
    });
    const byId = Object.fromEntries(r.map(d => [d.user_id, d.amount]));
    expect(byId.u1).toBe(40);
    for (const id of ['u2','u3','u4','u5','u6']) expect(byId[id]).toBe(0);
    for (let i = 7; i <= 10; i++) expect(byId[`u${i}`]).toBe(-10);
    expect(r.reduce((s, d) => s + d.amount, 0)).toBeCloseTo(0, 10);
  });

  it('4-way tie at 2 (K=4, like RBC Canadian Open 2026) → still fully distributes pot', () => {
    // Occupies 2/3/4/5. Combined = 30+20+0+0 = 50%. $12.50 each gross,
    // net $2.50. Rank 1: $40. Others: -$10.
    const results = [
      { user_id: 'u1', rank: 1 },
      ...['u2','u3','u4','u5'].map(id => ({ user_id: id, rank: 2 })),
      ...Array.from({ length: 5 }, (_, i) => ({
        user_id: `u${i + 6}`, rank: i + 6,
      })),
    ];
    const r = computeTournamentMoney({
      members: mk(results.map(x => x.user_id)),
      lockedAt: LOCK_TIME, results, betAmount: 10, payout: P_50_30_20,
    });
    const byId = Object.fromEntries(r.map(d => [d.user_id, d.amount]));
    expect(byId.u1).toBe(40);
    for (const id of ['u2','u3','u4','u5']) expect(byId[id]).toBe(2.5);
    for (let i = 6; i <= 10; i++) expect(byId[`u${i}`]).toBe(-10);
    expect(r.reduce((s, d) => s + d.amount, 0)).toBeCloseTo(0, 10);
  });
});

describe('computeTournamentMoney — PGA tie rule at rank 3', () => {
  it('2-way tie at 3 → they split just pct_3 (nothing to combine below)', () => {
    // Ranks 1,2 single, then tied at 3 (occupying 3&4). Combined
    // pct = 20+0 = 20%. Split 2 ways = 10% each × $100 = $10 gross,
    // net $0. Rank 1 gets $40, rank 2 gets $20.
    const results = [
      { user_id: 'u1', rank: 1 },
      { user_id: 'u2', rank: 2 },
      { user_id: 'u3', rank: 3 }, { user_id: 'u4', rank: 3 },
      ...Array.from({ length: 6 }, (_, i) => ({
        user_id: `u${i + 5}`, rank: i + 5,
      })),
    ];
    const r = computeTournamentMoney({
      members: mk(results.map(x => x.user_id)),
      lockedAt: LOCK_TIME, results, betAmount: 10, payout: P_50_30_20,
    });
    const byId = Object.fromEntries(r.map(d => [d.user_id, d.amount]));
    expect(byId.u1).toBe(40);
    expect(byId.u2).toBe(20);
    expect(byId.u3).toBe(0);
    expect(byId.u4).toBe(0);
    for (let i = 5; i <= 10; i++) expect(byId[`u${i}`]).toBe(-10);
    expect(r.reduce((s, d) => s + d.amount, 0)).toBeCloseTo(0, 10);
  });
});

describe('computeTournamentMoney — top-3 payout edge cases', () => {
  it('winner-take-all default matches old behavior — no payout param', () => {
    // Regression: passing no payout at all uses the WTA default,
    // which reproduces the legacy loser-pool math exactly.
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
    expect(byId.u1).toBe(30);   // 4 × $10 pot to rank 1, minus $10 ante
    expect(byId.u2).toBe(-10);
    expect(byId.u3).toBe(-10);
    expect(byId.u4).toBe(-10);
  });

  it('explicit PAYOUT_WINNER_TAKE_ALL is a no-op on top of default', () => {
    const r = computeTournamentMoney({
      members:  mk(['u1', 'u2', 'u3']),
      lockedAt: LOCK_TIME,
      results: [
        { user_id: 'u1', rank: 1 },
        { user_id: 'u2', rank: 2 },
        { user_id: 'u3', rank: 3 },
      ],
      betAmount: 10,
      payout: PAYOUT_WINNER_TAKE_ALL,
    });
    const byId = Object.fromEntries(r.map(d => [d.user_id, d.amount]));
    expect(byId.u1).toBe(20);
    expect(byId.u2).toBe(-10);
    expect(byId.u3).toBe(-10);
  });

  it('nobody at rank 1 → pot dissolves, all amounts 0', () => {
    // e.g., every user's picks all withdrew, so rank is null for all.
    const r = computeTournamentMoney({
      members:  mk(['u1', 'u2', 'u3']),
      lockedAt: LOCK_TIME,
      results: [
        { user_id: 'u1', rank: null },
        { user_id: 'u2', rank: null },
        { user_id: 'u3', rank: null },
      ],
      betAmount: 10,
      payout: P_50_30_20,
    });
    expect(r.every(d => d.amount === 0)).toBe(true);
  });

  it('late joiner excluded — algorithm still balances among eligible', () => {
    // 3 eligible + 1 late joiner. Pot = 3 × $10 = $30 (late joiner
    // not counted). With 50/30/20 top 3: r1=$15, r2=$9, r3=$6.
    // Nets: r1=+5, r2=-1, r3=-4. Late joiner: 0.
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
      payout: P_50_30_20,
    });
    const byId = Object.fromEntries(r.map(d => [d.user_id, d.amount]));
    expect(byId.u1).toBe(5);
    expect(byId.u2).toBe(-1);
    expect(byId.u3).toBe(-4);
    expect(byId.u4).toBe(0);
  });

  it('60/30/10 arbitrary split works — different percentages, same conservation', () => {
    const r = computeTournamentMoney({
      members: mk(['u1','u2','u3','u4','u5']),
      lockedAt: LOCK_TIME,
      results: [
        { user_id: 'u1', rank: 1 },
        { user_id: 'u2', rank: 2 },
        { user_id: 'u3', rank: 3 },
        { user_id: 'u4', rank: 4 },
        { user_id: 'u5', rank: 5 },
      ],
      betAmount: 10,
      payout: P_60_30_10,
    });
    const byId = Object.fromEntries(r.map(d => [d.user_id, d.amount]));
    // pot $50 — r1 60% = $30 gross, net +$20; r2 30% = $15, net +$5;
    // r3 10% = $5, net -$5.
    expect(byId.u1).toBe(20);
    expect(byId.u2).toBe(5);
    expect(byId.u3).toBe(-5);
    expect(byId.u4).toBe(-10);
    expect(byId.u5).toBe(-10);
    expect(r.reduce((s, d) => s + d.amount, 0)).toBeCloseTo(0, 10);
  });

  it('computeLeagueMoney propagates the league-level payout to every tournament', () => {
    // Two tournaments in a league configured 50/30/20. u1 sweeps.
    const r = computeLeagueMoney({
      members: mk(['u1', 'u2', 'u3', 'u4']),
      payout: P_50_30_20,
      tournaments: [
        {
          lockedAt: LOCK_TIME,
          betAmount: 10,
          results: [
            { user_id: 'u1', rank: 1 },
            { user_id: 'u2', rank: 2 },
            { user_id: 'u3', rank: 3 },
            { user_id: 'u4', rank: 4 },
          ],
        },
        {
          lockedAt: LOCK_TIME,
          betAmount: 10,
          results: [
            { user_id: 'u1', rank: 1 },
            { user_id: 'u2', rank: 2 },
            { user_id: 'u3', rank: 3 },
            { user_id: 'u4', rank: 4 },
          ],
        },
      ],
    });
    // Per tournament pot $40. Gross: r1=$20, r2=$12, r3=$8, r4=$0.
    // Nets: +$10, +$2, -$2, -$10. Doubled across 2 tournaments.
    const byId = Object.fromEntries(r.totals.map(d => [d.user_id, d.amount]));
    expect(byId.u1).toBe(20);
    expect(byId.u2).toBe(4);
    expect(byId.u3).toBe(-4);
    expect(byId.u4).toBe(-20);
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
