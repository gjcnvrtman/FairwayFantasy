import { describe, it, expect } from 'vitest';
import { validatePick, calculateTop3, applyFantasyRules } from '@/lib/scoring';

// ─────────────────────────────────────────────────────────────
// Test fixtures — small, named so failures are easy to read.
// ─────────────────────────────────────────────────────────────

// A handful of golfers with known tier classification.
//   Top tier:  scheffler (#1), mcilroy (#2), morikawa (#9)
//   Dark horse: bhatia (#28), pendrith (#26), sigg (#89)
//   Unranked:  ghostA, ghostB  (is_dark_horse = null per schema's
//              GENERATED ALWAYS AS (owgr_rank > 24) — null cmp null
//              produces null)
const G = {
  scheffler: { id: 'scheffler', name: 'Scottie Scheffler', owgr_rank:  1, is_dark_horse: false },
  mcilroy:   { id: 'mcilroy',   name: 'Rory McIlroy',      owgr_rank:  2, is_dark_horse: false },
  morikawa:  { id: 'morikawa',  name: 'Collin Morikawa',   owgr_rank:  9, is_dark_horse: false },
  bhatia:    { id: 'bhatia',    name: 'Akshay Bhatia',     owgr_rank: 28, is_dark_horse: true  },
  pendrith:  { id: 'pendrith',  name: 'Taylor Pendrith',   owgr_rank: 26, is_dark_horse: true  },
  sigg:      { id: 'sigg',      name: 'Greyson Sigg',      owgr_rank: 89, is_dark_horse: true  },
  // Unranked: schema generates null when owgr_rank is null.
  ghostA:    { id: 'ghostA',    name: 'Unranked Pro A',    owgr_rank: null, is_dark_horse: null },
  ghostB:    { id: 'ghostB',    name: 'Unranked Pro B',    owgr_rank: null, is_dark_horse: null },
};
const ALL = Object.values(G);

// Helper: a valid 4-pick layout we can mutate per test
function basePick(): (string | null)[] {
  return [G.scheffler.id, G.mcilroy.id, G.bhatia.id, G.pendrith.id];
}

describe('validatePick — happy path', () => {
  it('accepts a valid 2-top + 2-dark-horse foursome', () => {
    const errors = validatePick({
      golferIds:     basePick(),
      golfers:       ALL,
      existingPicks: [],
    });
    expect(errors).toEqual([]);
  });

  it('accepts unranked golfer in dark-horse slot', () => {
    const errors = validatePick({
      golferIds:     [G.scheffler.id, G.mcilroy.id, G.ghostA.id, G.ghostB.id],
      golfers:       ALL,
      existingPicks: [],
    });
    expect(errors).toEqual([]);
  });

  it('accepts an existing-picks list that has no overlapping foursome', () => {
    const otherFoursome = {
      golfer_1_id: G.morikawa.id, golfer_2_id: G.scheffler.id,
      golfer_3_id: G.sigg.id,     golfer_4_id: G.bhatia.id,
    };
    const errors = validatePick({
      golferIds:     basePick(),
      golfers:       ALL,
      existingPicks: [otherFoursome],
    });
    expect(errors).toEqual([]);
  });
});

describe('validatePick — completeness', () => {
  it('rejects when slot 1 is null', () => {
    const errors = validatePick({
      golferIds:     [null, G.mcilroy.id, G.bhatia.id, G.pendrith.id],
      golfers:       ALL,
      existingPicks: [],
    });
    expect(errors).toContain('You must select all 4 golfers.');
  });

  it('rejects when any slot is null', () => {
    for (let i = 0; i < 4; i++) {
      const ids = basePick();
      ids[i] = null;
      const errors = validatePick({ golferIds: ids, golfers: ALL, existingPicks: [] });
      expect(errors).toContain('You must select all 4 golfers.');
    }
  });

  it('rejects when all 4 slots are null', () => {
    const errors = validatePick({
      golferIds:     [null, null, null, null],
      golfers:       ALL,
      existingPicks: [],
    });
    expect(errors).toContain('You must select all 4 golfers.');
  });

  it('completeness check short-circuits before any other rule fires', () => {
    // If we have a tier-mismatch but slot is null, we should ONLY see
    // the "select all 4" error — saves the user from getting a wall
    // of errors when they haven't even finished picking.
    const errors = validatePick({
      golferIds:     [G.bhatia.id, G.mcilroy.id, null, G.pendrith.id],
      golfers:       ALL,
      existingPicks: [],
    });
    expect(errors).toEqual(['You must select all 4 golfers.']);
  });
});

describe('validatePick — duplicates', () => {
  it('rejects exact duplicate across slots 1 and 2', () => {
    const errors = validatePick({
      golferIds:     [G.scheffler.id, G.scheffler.id, G.bhatia.id, G.pendrith.id],
      golfers:       ALL,
      existingPicks: [],
    });
    expect(errors.some(e => e.includes('same golfer more than once'))).toBe(true);
  });

  it('rejects duplicate across top-tier and dark-horse slots', () => {
    const errors = validatePick({
      golferIds:     [G.scheffler.id, G.mcilroy.id, G.scheffler.id, G.pendrith.id],
      golfers:       ALL,
      existingPicks: [],
    });
    expect(errors.some(e => e.includes('same golfer more than once'))).toBe(true);
  });

  it('rejects all 4 slots with same golfer', () => {
    const errors = validatePick({
      golferIds:     [G.scheffler.id, G.scheffler.id, G.scheffler.id, G.scheffler.id],
      golfers:       ALL,
      existingPicks: [],
    });
    expect(errors.some(e => e.includes('same golfer more than once'))).toBe(true);
  });
});

describe('validatePick — tier rules', () => {
  it('rejects dark-horse golfer in top-tier slot', () => {
    const errors = validatePick({
      golferIds:     [G.bhatia.id, G.mcilroy.id, G.pendrith.id, G.sigg.id],
      golfers:       ALL,
      existingPicks: [],
    });
    const slotErr = errors.find(e => e.includes('Slot 1') && e.includes('top-tier'));
    expect(slotErr).toBeDefined();
    expect(slotErr).toContain('ranked 28');
  });

  it('rejects top-tier golfer in dark-horse slot', () => {
    const errors = validatePick({
      golferIds:     [G.scheffler.id, G.mcilroy.id, G.morikawa.id, G.pendrith.id],
      golfers:       ALL,
      existingPicks: [],
    });
    const slotErr = errors.find(e => e.includes('Slot 3') && e.includes('dark horse'));
    expect(slotErr).toBeDefined();
  });

  // Critical edge case from Prompt 1 review #5.4: schema produces
  // is_dark_horse=null for unranked golfers, JS coerces null to falsy,
  // so the OLD validatePick let unranked golfers into top-tier slots.
  // Fixed in scoring.ts now. These tests lock the fix in.
  it('rejects unranked golfer in top-tier slot (regression for #5.4)', () => {
    const errors = validatePick({
      golferIds:     [G.ghostA.id, G.mcilroy.id, G.bhatia.id, G.pendrith.id],
      golfers:       ALL,
      existingPicks: [],
    });
    const slotErr = errors.find(e => e.includes('Slot 1') && e.includes('top-tier'));
    expect(slotErr).toBeDefined();
    expect(slotErr).toContain('unranked');
  });

  it('rejects two unranked golfers in both top-tier slots', () => {
    const errors = validatePick({
      golferIds:     [G.ghostA.id, G.ghostB.id, G.bhatia.id, G.pendrith.id],
      golfers:       ALL,
      existingPicks: [],
    });
    expect(errors.some(e => e.includes('Slot 1') && e.includes('unranked'))).toBe(true);
    expect(errors.some(e => e.includes('Slot 2') && e.includes('unranked'))).toBe(true);
  });

  it('accepts unranked golfer in dark-horse slot (positive regression)', () => {
    // Mirror to the case above — unranked SHOULD be eligible for DH.
    const errors = validatePick({
      golferIds:     [G.scheffler.id, G.mcilroy.id, G.ghostA.id, G.bhatia.id],
      golfers:       ALL,
      existingPicks: [],
    });
    expect(errors).toEqual([]);
  });

  it('reports BOTH slot-3 AND slot-4 errors when both are wrong', () => {
    const errors = validatePick({
      golferIds:     [G.scheffler.id, G.mcilroy.id, G.morikawa.id, G.scheffler.id],
      // morikawa is top tier (ineligible DH), scheffler dup
      golfers:       ALL,
      existingPicks: [],
    });
    expect(errors.some(e => e.includes('Slot 3'))).toBe(true);
  });
});

describe('validatePick — no-copycats rule', () => {
  function asExisting(ids: string[]) {
    return {
      golfer_1_id: ids[0], golfer_2_id: ids[1],
      golfer_3_id: ids[2], golfer_4_id: ids[3],
    };
  }

  it('rejects an identical foursome already in the league', () => {
    const errors = validatePick({
      golferIds:     basePick(),
      golfers:       ALL,
      existingPicks: [asExisting(basePick() as string[])],
    });
    expect(errors.some(e => e.includes('exact combination'))).toBe(true);
  });

  it('rejects identical foursome regardless of slot order', () => {
    // Same 4 golfers in different slot positions = still a copycat
    // (the rule is set-based, not order-based).
    const errors = validatePick({
      golferIds:     basePick(), // [scheffler, mcilroy, bhatia, pendrith]
      golfers:       ALL,
      existingPicks: [asExisting([
        G.mcilroy.id, G.scheffler.id, // tops swapped
        G.pendrith.id, G.bhatia.id,   // dh swapped
      ])],
    });
    expect(errors.some(e => e.includes('exact combination'))).toBe(true);
  });

  it('accepts when 3 of 4 overlap but the 4th differs', () => {
    const errors = validatePick({
      golferIds:     basePick(), // [scheffler, mcilroy, bhatia, pendrith]
      golfers:       ALL,
      existingPicks: [asExisting([
        G.scheffler.id, G.mcilroy.id, G.bhatia.id, G.sigg.id, // pendrith → sigg
      ])],
    });
    expect(errors).toEqual([]);
  });

  it('handles multiple existing picks; rejects only when one matches', () => {
    const errors = validatePick({
      golferIds:     basePick(),
      golfers:       ALL,
      existingPicks: [
        asExisting([G.morikawa.id, G.scheffler.id, G.sigg.id, G.pendrith.id]),
        asExisting([G.scheffler.id, G.mcilroy.id, G.bhatia.id, G.pendrith.id]), // copycat
        asExisting([G.morikawa.id, G.mcilroy.id, G.sigg.id, G.bhatia.id]),
      ],
    });
    expect(errors.filter(e => e.includes('exact combination'))).toHaveLength(1);
  });

  it('accepts when existing-picks list is empty', () => {
    const errors = validatePick({
      golferIds:     basePick(),
      golfers:       ALL,
      existingPicks: [],
    });
    expect(errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// Adjacent rule logic tested while we're here. These were
// flagged in the Prompt 1 review (#5.1, #5.2, #5.3).
// ─────────────────────────────────────────────────────────────

describe('calculateTop3', () => {
  it('returns sum of best 3 (lowest = best in golf)', () => {
    const r = calculateTop3([-3, -1, 0, +2]);
    expect(r.total).toBe(-4); // -3 + -1 + 0
    expect(r.countingIndices).toEqual([0, 1, 2]);
  });

  it('drops the worst slot regardless of position', () => {
    // worst (highest) is slot 0 (+5), should drop it
    const r = calculateTop3([+5, -2, 0, -3]);
    expect(r.total).toBe(-5); // -3 + -2 + 0
    expect(r.countingIndices).toEqual([3, 1, 2]);
  });

  it('returns null total when all slots are null', () => {
    expect(calculateTop3([null, null, null, null])).toEqual({
      countingIndices: [], total: null,
    });
  });

  it('returns sum of remaining when fewer than 3 are scored (Prompt 1 #5.3)', () => {
    // This is the documented behavior — a user with only 2 scored
    // golfers totalling -5 will outrank a user with 3 scored
    // totalling -4. Locked in here so any future change to "tied or
    // pro-rated when partial" surfaces as a test failure.
    const r = calculateTop3([null, -3, null, -2]);
    expect(r.total).toBe(-5);
    expect(r.countingIndices).toEqual([1, 3]);
  });

  it('handles ties (same score in multiple slots)', () => {
    const r = calculateTop3([-2, -2, -2, +1]);
    expect(r.total).toBe(-6); // -2 -2 -2
    expect(r.countingIndices).toHaveLength(3);
  });
});

describe('applyFantasyRules', () => {
  it('caps made-cut score at the cut line (cap rule)', () => {
    // Player at +5 with cut at +3 → score capped at +3.
    const r = applyFantasyRules({ scoreToParRaw: '+5', espnStatus: 'active', cutScore: 3 });
    expect(r.fantasyScore).toBe(3);
    expect(r.status).toBe('active');
  });

  it('keeps a better-than-cut active score as-is', () => {
    // Player at -10 with cut at +3 → keep -10 (much better than cut).
    const r = applyFantasyRules({ scoreToParRaw: '-10', espnStatus: 'active', cutScore: 3 });
    expect(r.fantasyScore).toBe(-10);
  });

  it('missed-cut score = cutScore + 1', () => {
    const r = applyFantasyRules({ scoreToParRaw: '+8', espnStatus: 'cut', cutScore: 3 });
    expect(r.fantasyScore).toBe(4);
    expect(r.status).toBe('missed_cut');
  });

  it('withdrawn returns null score (eligible for replacement)', () => {
    const r = applyFantasyRules({ scoreToParRaw: '-1', espnStatus: 'withdrew', cutScore: 3 });
    expect(r.fantasyScore).toBeNull();
    expect(r.status).toBe('withdrawn');
  });

  it('disqualified returns null score', () => {
    const r = applyFantasyRules({ scoreToParRaw: '+2', espnStatus: 'DQ', cutScore: 3 });
    expect(r.fantasyScore).toBeNull();
    expect(r.status).toBe('disqualified');
  });

  // Prompt 1 review #5.2: when cutScore is null but golfer missed cut,
  // the formula falls back to rawScore + 1 — which is wrong for very
  // good rounds (-3 → -2 still better than legit cut survivors). This
  // test pins the CURRENT behavior so we notice if we fix #5.2 later.
  it('missed-cut with null cutScore falls back to rawScore+1 (KNOWN BUG #5.2)', () => {
    const r = applyFantasyRules({ scoreToParRaw: '-3', espnStatus: 'cut', cutScore: null });
    // Documented bug: returns -2 (which is BETTER than legitimate cut
    // survivors). Should arguably be a high penalty number. Pinning
    // current behavior so the fix is intentional.
    expect(r.fantasyScore).toBe(-2);
    expect(r.status).toBe('missed_cut');
  });

  it('parses "E" (even par) correctly', () => {
    const r = applyFantasyRules({ scoreToParRaw: 'E', espnStatus: 'active', cutScore: null });
    expect(r.fantasyScore).toBe(0);
  });
});
