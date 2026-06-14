// Tests for computeTopTierIds — the per-tournament tier classifier
// in src/lib/field-tiers.ts. Replaces the global golfers.is_dark_horse
// gate at pick-eligibility time.

import { describe, it, expect } from 'vitest';
import { computeTopTierIds, TOP_TIER_SIZE } from '@/lib/field-tiers';

describe('computeTopTierIds — basic classification', () => {
  it('top tier = up to TOP_TIER_SIZE highest-ranked golfers in the field', () => {
    const field = Array.from({ length: 50 }, (_, i) => ({
      id: `g-${i + 1}`,
      owgr_rank: i + 1,
    }));
    const top = computeTopTierIds(field);
    expect(top.size).toBe(TOP_TIER_SIZE);
    for (let i = 1; i <= TOP_TIER_SIZE; i++) {
      expect(top.has(`g-${i}`)).toBe(true);
    }
    for (let i = TOP_TIER_SIZE + 1; i <= 50; i++) {
      expect(top.has(`g-${i}`)).toBe(false);
    }
  });

  it('unranked golfers NEVER enter top tier even when field has < TOP_TIER_SIZE ranked', () => {
    // 10 ranked + 50 unranked. Top tier = 10 (all ranked); the 14
    // remaining "slots" stay empty — we do NOT pad with unranked.
    const field = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `r-${i + 1}`, owgr_rank: i + 1 })),
      ...Array.from({ length: 50 }, (_, i) => ({ id: `u-${i + 1}`, owgr_rank: null as number | null })),
    ];
    const top = computeTopTierIds(field);
    expect(top.size).toBe(10);
    for (const id of top) expect(id.startsWith('r-')).toBe(true);
  });

  it('handles a tournament with zero ranked golfers (empty top tier)', () => {
    const field = Array.from({ length: 20 }, (_, i) => ({
      id: `u-${i + 1}`,
      owgr_rank: null as number | null,
    }));
    expect(computeTopTierIds(field).size).toBe(0);
  });

  it('handles an empty field', () => {
    expect(computeTopTierIds([]).size).toBe(0);
  });
});

describe('computeTopTierIds — field-relative semantics', () => {
  it('a weak-field event can have a globally-OWGR-50 golfer in top tier', () => {
    // Reality check: a Fall Series event might have only ~15 top-50
    // golfers playing. Under the new rule, all 15 are top-tier (plus
    // the next 9 lower-ranked in the field, if there are 24 ranked
    // total).
    const field = [
      { id: 'rory',    owgr_rank: 2  },  // strong
      { id: 'fitz',    owgr_rank: 18 },  // strong
      { id: 'novak',   owgr_rank: 60 },  // would NOT be top-24 globally
      { id: 'kovak',   owgr_rank: 95 },  // would NOT be top-24 globally
      ...Array.from({ length: 100 }, (_, i) => ({
        id: `pro-${i + 1}`, owgr_rank: null as number | null,
      })),
    ];
    const top = computeTopTierIds(field);
    expect(top.has('rory')).toBe(true);
    expect(top.has('fitz')).toBe(true);
    expect(top.has('novak')).toBe(true);   // top-4 of THIS field
    expect(top.has('kovak')).toBe(true);   // top-4 of THIS field
    for (let i = 1; i <= 100; i++) {
      expect(top.has(`pro-${i}`)).toBe(false);
    }
  });

  it('a strong-field event caps at TOP_TIER_SIZE even with 50+ ranked', () => {
    const field = Array.from({ length: 100 }, (_, i) => ({
      id: `g-${i + 1}`,
      owgr_rank: i + 1,
    }));
    const top = computeTopTierIds(field);
    expect(top.size).toBe(TOP_TIER_SIZE);
    expect(top.has('g-24')).toBe(true);
    expect(top.has('g-25')).toBe(false);
  });
});

describe('computeTopTierIds — custom size + tiebreaking', () => {
  it('honors a custom size argument', () => {
    const field = Array.from({ length: 30 }, (_, i) => ({
      id: `g-${i + 1}`,
      owgr_rank: i + 1,
    }));
    expect(computeTopTierIds(field, 10).size).toBe(10);
    expect(computeTopTierIds(field, 0).size).toBe(0);
  });

  it('breaks rank ties by id (deterministic) — defensive, ties shouldn’t happen in OWGR', () => {
    // If two golfers somehow share rank, the id-asc tiebreak picks the
    // earlier id. This is a defensive contract, not an expected case.
    const field = [
      { id: 'a', owgr_rank: 5 },
      { id: 'b', owgr_rank: 5 },
      { id: 'c', owgr_rank: 6 },
    ];
    const top = computeTopTierIds(field, 2);
    expect(top.has('a')).toBe(true);
    expect(top.has('b')).toBe(true);
    expect(top.has('c')).toBe(false);
  });
});
