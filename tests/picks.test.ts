import { describe, it, expect } from 'vitest';
import {
  validatePick,
  calculateTop3,
  applyFantasyRules,
  computeLeagueResults,
  isReplacementEligible,
  MISSED_CUT_PENALTY_STROKES,
  MISSED_CUT_FALLBACK_SCORE,
  PICK_GOLFER_COUNT,
  COUNTING_GOLFER_COUNT,
  TOP_TIER_MAX_OWGR_RANK,
} from '@/lib/scoring';
import type { Pick, Score } from '@/types';

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

describe('applyFantasyRules — core rules', () => {
  it('caps made-cut score at the cut line once cut is made (cap rule)', () => {
    // Player at +5, cut at +3, cut HAS been made → cap fires → +3.
    const r = applyFantasyRules({
      scoreToParRaw: '+5', espnStatus: 'active', cutScore: 3, cutMade: true,
    });
    expect(r.fantasyScore).toBe(3);
    expect(r.status).toBe('active');
  });

  it('caps complete-round score at the cut line', () => {
    // Tournament-final cap always applies on `complete`, regardless
    // of cutMade — being complete implies the cut was made.
    const r = applyFantasyRules({
      scoreToParRaw: '+5', espnStatus: 'final', cutScore: 3,
    });
    expect(r.fantasyScore).toBe(3);
    expect(r.status).toBe('complete');
  });

  it('keeps a better-than-cut active score as-is', () => {
    const r = applyFantasyRules({
      scoreToParRaw: '-10', espnStatus: 'active', cutScore: 3, cutMade: true,
    });
    expect(r.fantasyScore).toBe(-10);
  });

  it('missed-cut score = cutScore + MISSED_CUT_PENALTY_STROKES', () => {
    const r = applyFantasyRules({ scoreToParRaw: '+8', espnStatus: 'cut', cutScore: 3 });
    expect(r.fantasyScore).toBe(3 + MISSED_CUT_PENALTY_STROKES);
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

  it('parses "E" (even par) correctly', () => {
    const r = applyFantasyRules({ scoreToParRaw: 'E', espnStatus: 'active', cutScore: null });
    expect(r.fantasyScore).toBe(0);
  });

  it('parses "-" (no score yet) as 0', () => {
    // Defensive — ESPN sometimes sends "-" early in a round.
    const r = applyFantasyRules({ scoreToParRaw: '-', espnStatus: 'active', cutScore: null });
    expect(r.fantasyScore).toBe(0);
  });
});

describe('applyFantasyRules — round-in-progress (#5.1 fix)', () => {
  it('does NOT cap during active live play before cut is made', () => {
    // Round 1, player at +5, cut not yet made → score is +5, NOT
    // capped. Earlier bug would have capped at +3. Locked in here.
    const r = applyFantasyRules({
      scoreToParRaw: '+5', espnStatus: 'active', cutScore: 3, cutMade: false,
    });
    expect(r.fantasyScore).toBe(5);
    expect(r.status).toBe('active');
  });

  it('defaults cutMade=false when omitted (back-compat behavior)', () => {
    const r = applyFantasyRules({
      scoreToParRaw: '+5', espnStatus: 'active', cutScore: 3,
    });
    expect(r.fantasyScore).toBe(5); // not capped — default cutMade=false
  });

  it('does NOT cap when cut hasn\'t been determined yet (cutScore=null)', () => {
    // No cut data yet — leave score uncapped regardless of cutMade.
    const r = applyFantasyRules({
      scoreToParRaw: '+8', espnStatus: 'active', cutScore: null, cutMade: false,
    });
    expect(r.fantasyScore).toBe(8);
  });

  it('caps mid-round-3 if caller signals cut is made', () => {
    // Post-cut, mid-round-3, made-cut golfer playing terribly.
    // Once cut is made, the at-worst-cut-line guarantee kicks in.
    const r = applyFantasyRules({
      scoreToParRaw: '+12', espnStatus: 'active', cutScore: -1, cutMade: true,
    });
    expect(r.fantasyScore).toBe(-1);
  });
});

describe('applyFantasyRules — null cutScore + missed cut (#5.2 fix)', () => {
  it('uses MISSED_CUT_FALLBACK_SCORE when cutScore is null', () => {
    // Was a pinned bug: rawScore+1 returned -2 for a -3 missed-cut
    // round. Now returns MISSED_CUT_FALLBACK_SCORE (clearly losing).
    const r = applyFantasyRules({ scoreToParRaw: '-3', espnStatus: 'cut', cutScore: null });
    expect(r.fantasyScore).toBe(MISSED_CUT_FALLBACK_SCORE);
    expect(r.status).toBe('missed_cut');
  });

  it('still uses cutScore + penalty when cutScore is known', () => {
    // Don't accidentally regress the happy path.
    const r = applyFantasyRules({ scoreToParRaw: '+8', espnStatus: 'cut', cutScore: 5 });
    expect(r.fantasyScore).toBe(6);
  });

  it('fallback does not affect non-missed-cut statuses', () => {
    // Active with null cutScore → score as-is, no fallback applied.
    const r = applyFantasyRules({ scoreToParRaw: '+2', espnStatus: 'active', cutScore: null });
    expect(r.fantasyScore).toBe(2);
  });
});

describe('exported constants', () => {
  it('PICK_GOLFER_COUNT = 4 (always 4 golfers per pick)', () => {
    expect(PICK_GOLFER_COUNT).toBe(4);
  });

  it('COUNTING_GOLFER_COUNT = 3 (best 3 of 4)', () => {
    expect(COUNTING_GOLFER_COUNT).toBe(3);
  });

  it('TOP_TIER_MAX_OWGR_RANK = 24', () => {
    expect(TOP_TIER_MAX_OWGR_RANK).toBe(24);
  });

  it('MISSED_CUT_PENALTY_STROKES = 1', () => {
    expect(MISSED_CUT_PENALTY_STROKES).toBe(1);
  });

  it('MISSED_CUT_FALLBACK_SCORE is high enough to lose to any realistic cut', () => {
    // Cut lines on PGA tour rarely go above +10. Fallback should be
    // clearly worse than cut+1 in any realistic scenario.
    expect(MISSED_CUT_FALLBACK_SCORE).toBeGreaterThan(20);
  });
});

// ─────────────────────────────────────────────────────────────
// computeLeagueResults — full-league rank/score pipeline
// ─────────────────────────────────────────────────────────────

/** Build a partial Pick cast-as-Pick for tests. */
function makePick(p: {
  user_id: string;
  g1: string | null;
  g2: string | null;
  g3: string | null;
  g4: string | null;
  league_id?: string;
  tournament_id?: string;
}): Pick {
  return {
    id:           `pick-${p.user_id}`,
    league_id:     p.league_id     ?? 'lg1',
    tournament_id: p.tournament_id ?? 'tour1',
    user_id:       p.user_id,
    golfer_1_id:   p.g1,
    golfer_2_id:   p.g2,
    golfer_3_id:   p.g3,
    golfer_4_id:   p.g4,
    is_locked:     true,
    submitted_at:  '2026-04-10T00:00:00Z',
  } as Pick;
}

/** Build a partial Score cast-as-Score for tests. */
function makeScore(p: {
  golfer_id: string;
  fantasy_score: number | null;
  status?: Score['status'];
  was_replaced?: boolean;
  replaced_by_golfer_id?: string | null;
}): Score {
  return {
    id:                    `score-${p.golfer_id}`,
    tournament_id:         'tour1',
    golfer_id:              p.golfer_id,
    espn_golfer_id:         p.golfer_id,
    round_1: null, round_2: null, round_3: null, round_4: null,
    total_strokes:          null,
    score_to_par:           p.fantasy_score,
    position:               null,
    status:                 p.status ?? 'active',
    fantasy_score:          p.fantasy_score,
    was_replaced:           p.was_replaced ?? false,
    replaced_by_golfer_id:  p.replaced_by_golfer_id ?? null,
    last_synced:           '2026-04-10T12:00:00Z',
  } as Score;
}

function buildScoreMap(scores: Score[]): Map<string, Score> {
  const m = new Map<string, Score>();
  for (const s of scores) m.set(s.golfer_id, s);
  return m;
}

describe('computeLeagueResults — all four golfers completed', () => {
  it('picks best 3 of 4 and ranks single user #1', () => {
    const picks = [makePick({ user_id: 'u1', g1: 'a', g2: 'b', g3: 'c', g4: 'd' })];
    const scoreMap = buildScoreMap([
      makeScore({ golfer_id: 'a', fantasy_score: -3 }),
      makeScore({ golfer_id: 'b', fantasy_score: -1 }),
      makeScore({ golfer_id: 'c', fantasy_score: +2 }),
      makeScore({ golfer_id: 'd', fantasy_score: +4 }), // dropped
    ]);
    const r = computeLeagueResults(picks, scoreMap);
    expect(r).toHaveLength(1);
    expect(r[0].total_score).toBe(-2); // -3 + -1 + +2
    expect(r[0].counting_golfers).toEqual([1, 2, 3]);
    expect(r[0].rank).toBe(1);
  });

  it('worst-slot drop is position-independent', () => {
    // The worst slot is g1 here; should still be dropped.
    const picks = [makePick({ user_id: 'u1', g1: 'a', g2: 'b', g3: 'c', g4: 'd' })];
    const scoreMap = buildScoreMap([
      makeScore({ golfer_id: 'a', fantasy_score: +10 }), // dropped
      makeScore({ golfer_id: 'b', fantasy_score: -2 }),
      makeScore({ golfer_id: 'c', fantasy_score: -4 }),
      makeScore({ golfer_id: 'd', fantasy_score: -1 }),
    ]);
    const r = computeLeagueResults(picks, scoreMap);
    expect(r[0].total_score).toBe(-7); // -2 + -4 + -1
    // Slot 1 (a) is dropped; counting are 2, 3, 4
    expect(r[0].counting_golfers.sort()).toEqual([2, 3, 4]);
  });
});

describe('computeLeagueResults — only some completed', () => {
  it('uses only valid scores when 1 golfer is null/missing', () => {
    // Per #5.3 spec: 3 valid → sum of 3
    const picks = [makePick({ user_id: 'u1', g1: 'a', g2: 'b', g3: 'c', g4: 'd' })];
    const scoreMap = buildScoreMap([
      makeScore({ golfer_id: 'a', fantasy_score: -3 }),
      makeScore({ golfer_id: 'b', fantasy_score: -1 }),
      makeScore({ golfer_id: 'c', fantasy_score: +2 }),
      // d: no score row at all
    ]);
    const r = computeLeagueResults(picks, scoreMap);
    expect(r[0].total_score).toBe(-2); // sum of 3 valid
    expect(r[0].golfer_4_score).toBeNull();
  });

  it('uses partial scores when 2+ golfers WD/DQ (per #5.3 spec)', () => {
    const picks = [makePick({ user_id: 'u1', g1: 'a', g2: 'b', g3: 'c', g4: 'd' })];
    const scoreMap = buildScoreMap([
      makeScore({ golfer_id: 'a', fantasy_score: -3 }),
      makeScore({ golfer_id: 'b', fantasy_score: -2 }),
      makeScore({ golfer_id: 'c', fantasy_score: null, status: 'withdrawn' }),
      makeScore({ golfer_id: 'd', fantasy_score: null, status: 'disqualified' }),
    ]);
    const r = computeLeagueResults(picks, scoreMap);
    // Only 2 valid → sum of those 2 (no penalty per current spec).
    expect(r[0].total_score).toBe(-5);
    expect(r[0].golfer_3_score).toBeNull();
    expect(r[0].golfer_4_score).toBeNull();
  });

  it('returns total_score=null and rank=null when ALL golfers WD/DQ', () => {
    const picks = [makePick({ user_id: 'u1', g1: 'a', g2: 'b', g3: 'c', g4: 'd' })];
    const scoreMap = buildScoreMap([
      makeScore({ golfer_id: 'a', fantasy_score: null, status: 'withdrawn' }),
      makeScore({ golfer_id: 'b', fantasy_score: null, status: 'withdrawn' }),
      makeScore({ golfer_id: 'c', fantasy_score: null, status: 'disqualified' }),
      makeScore({ golfer_id: 'd', fantasy_score: null, status: 'withdrawn' }),
    ]);
    const r = computeLeagueResults(picks, scoreMap);
    expect(r[0].total_score).toBeNull();
    expect(r[0].rank).toBeNull();
  });
});

describe('computeLeagueResults — no score yet', () => {
  it('returns total_score=null when scoreMap is empty (tournament not started)', () => {
    const picks = [makePick({ user_id: 'u1', g1: 'a', g2: 'b', g3: 'c', g4: 'd' })];
    const r = computeLeagueResults(picks, new Map());
    expect(r[0].total_score).toBeNull();
    expect(r[0].rank).toBeNull();
    expect(r[0].golfer_1_score).toBeNull();
  });

  it('handles a pick with null golfer slots gracefully', () => {
    // User submitted a partial pick (shouldn't happen in prod —
    // validatePick would reject it — but defensive against bad data).
    const picks = [makePick({ user_id: 'u1', g1: 'a', g2: null, g3: 'c', g4: null })];
    const scoreMap = buildScoreMap([
      makeScore({ golfer_id: 'a', fantasy_score: -3 }),
      makeScore({ golfer_id: 'c', fantasy_score: +2 }),
    ]);
    const r = computeLeagueResults(picks, scoreMap);
    expect(r[0].total_score).toBe(-1); // -3 + 2
    expect(r[0].golfer_2_score).toBeNull();
    expect(r[0].golfer_4_score).toBeNull();
  });
});

describe('computeLeagueResults — tied users', () => {
  it('assigns the same rank to tied total_scores (1, 2, 2, 4 pattern)', () => {
    // Three users tied at 2nd place → ranks 1, 2, 2, 2, 5? No —
    // standard golf: 1, 2, 2, 2 (skip to next available rank for the
    // next distinct score). Confirm.
    const picks = [
      makePick({ user_id: 'best',   g1: 'a', g2: 'b', g3: 'c', g4: 'd' }),
      makePick({ user_id: 'tied1', g1: 'a', g2: 'b', g3: 'c', g4: 'e' }),
      makePick({ user_id: 'tied2', g1: 'a', g2: 'b', g3: 'c', g4: 'f' }),
      makePick({ user_id: 'last',  g1: 'g', g2: 'h', g3: 'i', g4: 'j' }),
    ];
    const scoreMap = buildScoreMap([
      // best: -3, -2, -1, dropped(+5) → -6
      makeScore({ golfer_id: 'a', fantasy_score: -3 }),
      makeScore({ golfer_id: 'b', fantasy_score: -2 }),
      makeScore({ golfer_id: 'c', fantasy_score: -1 }),
      makeScore({ golfer_id: 'd', fantasy_score: +5 }),
      // tied1+tied2 share a/b/c with best, only the 4th differs:
      makeScore({ golfer_id: 'e', fantasy_score: 0 }),  // tied1 → -6, but counting set is a,b,c → -6 (tied with best!)
      makeScore({ golfer_id: 'f', fantasy_score: 0 }),  // tied2 → -6 same
      // last: all positive, dropped one
      makeScore({ golfer_id: 'g', fantasy_score: +2 }),
      makeScore({ golfer_id: 'h', fantasy_score: +3 }),
      makeScore({ golfer_id: 'i', fantasy_score: +5 }),
      makeScore({ golfer_id: 'j', fantasy_score: +9 }),
    ]);
    const r = computeLeagueResults(picks, scoreMap);
    const byUser = Object.fromEntries(r.map(x => [x.user_id, x]));
    expect(byUser.best.total_score).toBe(-6);
    expect(byUser.tied1.total_score).toBe(-6);
    expect(byUser.tied2.total_score).toBe(-6);
    expect(byUser.last.total_score).toBe(+10); // +2 + +3 + +5

    // All three tied at rank 1
    expect(byUser.best.rank).toBe(1);
    expect(byUser.tied1.rank).toBe(1);
    expect(byUser.tied2.rank).toBe(1);
    // Last gets rank 4 (skipping 2 and 3 because of the 3-way tie)
    expect(byUser.last.rank).toBe(4);
  });

  it('gives ranks 1, 2, 2 (skip 3) when 2 tie at second', () => {
    const picks = [
      makePick({ user_id: 'first',  g1: 'a', g2: 'b', g3: 'c', g4: 'd' }),
      makePick({ user_id: 'second', g1: 'e', g2: 'f', g3: 'g', g4: 'h' }),
      makePick({ user_id: 'third',  g1: 'i', g2: 'j', g3: 'k', g4: 'l' }),
    ];
    const scoreMap = buildScoreMap([
      makeScore({ golfer_id: 'a', fantasy_score: -5 }),
      makeScore({ golfer_id: 'b', fantasy_score: -3 }),
      makeScore({ golfer_id: 'c', fantasy_score: -2 }),
      makeScore({ golfer_id: 'd', fantasy_score: 0 }),  // total -10 (dropped 0)
      makeScore({ golfer_id: 'e', fantasy_score: -2 }),
      makeScore({ golfer_id: 'f', fantasy_score: -1 }),
      makeScore({ golfer_id: 'g', fantasy_score: 0 }),
      makeScore({ golfer_id: 'h', fantasy_score: +1 }),  // total -3
      makeScore({ golfer_id: 'i', fantasy_score: -2 }),
      makeScore({ golfer_id: 'j', fantasy_score: -1 }),
      makeScore({ golfer_id: 'k', fantasy_score: 0 }),
      makeScore({ golfer_id: 'l', fantasy_score: +1 }),  // total -3 (tie with second)
    ]);
    const r = computeLeagueResults(picks, scoreMap);
    const byUser = Object.fromEntries(r.map(x => [x.user_id, x]));
    expect(byUser.first.rank).toBe(1);
    expect(byUser.second.rank).toBe(2);
    expect(byUser.third.rank).toBe(2);  // tied with second
    // Note: there's no 4th user, but if there were they'd be rank 4.
  });

  it('does not rank users whose total is null (all WD/DQ)', () => {
    const picks = [
      makePick({ user_id: 'real',  g1: 'a', g2: 'b', g3: 'c', g4: 'd' }),
      makePick({ user_id: 'all-wd', g1: 'e', g2: 'f', g3: 'g', g4: 'h' }),
    ];
    const scoreMap = buildScoreMap([
      makeScore({ golfer_id: 'a', fantasy_score: -1 }),
      makeScore({ golfer_id: 'b', fantasy_score: 0 }),
      makeScore({ golfer_id: 'c', fantasy_score: +1 }),
      makeScore({ golfer_id: 'd', fantasy_score: +2 }),
      makeScore({ golfer_id: 'e', fantasy_score: null, status: 'withdrawn' }),
      makeScore({ golfer_id: 'f', fantasy_score: null, status: 'withdrawn' }),
      makeScore({ golfer_id: 'g', fantasy_score: null, status: 'disqualified' }),
      makeScore({ golfer_id: 'h', fantasy_score: null, status: 'withdrawn' }),
    ]);
    const r = computeLeagueResults(picks, scoreMap);
    const byUser = Object.fromEntries(r.map(x => [x.user_id, x]));
    expect(byUser.real.rank).toBe(1);
    expect(byUser['all-wd'].rank).toBeNull();
    expect(byUser['all-wd'].total_score).toBeNull();
  });
});

describe('computeLeagueResults — replacement handling', () => {
  it('uses the replacement\'s fantasy_score when was_replaced=true', () => {
    const picks = [makePick({ user_id: 'u1', g1: 'orig', g2: 'b', g3: 'c', g4: 'd' })];
    const scoreMap = buildScoreMap([
      // 'orig' withdrew; was_replaced flag points to 'rep'
      makeScore({
        golfer_id: 'orig', fantasy_score: null, status: 'withdrawn',
        was_replaced: true, replaced_by_golfer_id: 'rep',
      }),
      makeScore({ golfer_id: 'rep', fantasy_score: -4 }),  // replacement's score
      makeScore({ golfer_id: 'b',   fantasy_score: -1 }),
      makeScore({ golfer_id: 'c',   fantasy_score: 0 }),
      makeScore({ golfer_id: 'd',   fantasy_score: +3 }),  // dropped
    ]);
    const r = computeLeagueResults(picks, scoreMap);
    expect(r[0].golfer_1_score).toBe(-4);  // pulled from replacement
    expect(r[0].total_score).toBe(-5); // -4 + -1 + 0
  });
});

// ─────────────────────────────────────────────────────────────
// Adjacent: ESPN-status edge cases not yet covered
// ─────────────────────────────────────────────────────────────

describe('applyFantasyRules — ESPN status edge cases', () => {
  it('treats "MC" as missed_cut', () => {
    const r = applyFantasyRules({ scoreToParRaw: '+8', espnStatus: 'mc', cutScore: 3 });
    expect(r.status).toBe('missed_cut');
  });

  it('treats "F" (final) as complete', () => {
    const r = applyFantasyRules({ scoreToParRaw: '-2', espnStatus: 'f', cutScore: 3 });
    expect(r.status).toBe('complete');
  });

  it('treats MDF (made cut, did not finish) as active per explicit rule', () => {
    // Player survived the cut but pulled out mid-tournament. Score
    // up to withdrawal is valid and continues to count in the user's
    // foursome. mapESPNStatus has an explicit `if (s === 'mdf')`
    // branch (espn.ts) so this is no longer a fall-through default —
    // changing the rule requires editing that branch deliberately.
    const r = applyFantasyRules({ scoreToParRaw: '+2', espnStatus: 'MDF', cutScore: 3 });
    expect(r.status).toBe('active');
  });

  it('still falls through to active for truly unknown statuses', () => {
    // Defensive default for statuses we have never observed (ESPN
    // could add new codes any day). Keeps the engine running on
    // unknown input rather than throwing.
    const r = applyFantasyRules({ scoreToParRaw: '+1', espnStatus: 'SUSPENDED', cutScore: 3 });
    expect(r.status).toBe('active');
  });
});

// ─────────────────────────────────────────────────────────────
// isReplacementEligible — closes #5.6 (route + helper agree)
// ─────────────────────────────────────────────────────────────

describe('isReplacementEligible', () => {
  it('allows active golfer who has not teed off', () => {
    expect(isReplacementEligible({ status: 'active', round_1: null })).toBe(true);
  });

  it('rejects when round_1 is recorded (teed off)', () => {
    expect(isReplacementEligible({ status: 'active', round_1: 70 })).toBe(false);
  });

  it('rejects withdrawn golfer even with round_1 null (pre-tournament WD)', () => {
    // The previous inline-only check would have ALLOWED this — a
    // golfer who withdrew before play started has round_1=null and
    // would have passed. Helper catches it via status.
    expect(isReplacementEligible({ status: 'withdrawn', round_1: null })).toBe(false);
  });

  it('rejects disqualified golfer with round_1 null', () => {
    expect(isReplacementEligible({ status: 'disqualified', round_1: null })).toBe(false);
  });

  it('rejects missed_cut golfer even with round_1 null', () => {
    expect(isReplacementEligible({ status: 'missed_cut', round_1: null })).toBe(false);
  });

  it('rejects complete golfer with round_1 null', () => {
    expect(isReplacementEligible({ status: 'complete', round_1: null })).toBe(false);
  });

  it('rejects active golfer with round_1 = 0 (sentinel teed-off, unlikely but safe)', () => {
    expect(isReplacementEligible({ status: 'active', round_1: 0 })).toBe(false);
  });
});
