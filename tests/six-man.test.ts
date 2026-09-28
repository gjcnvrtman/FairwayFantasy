// 6-man teams for majors (migration 026). 4-man behavior is pinned by
// the existing picks / auto-lineup suites; these cover the 6-man shape.

import { describe, it, expect } from 'vitest';
import { TEAM_4, TEAM_6, teamShapeFor, pickGolferIds, teamSlots } from '@/lib/team-shape';
import {
  validatePick, computeLeagueResults, buildAutoLineup, computeFoursomeHash,
  DUPLICATE_FOURSOME_MESSAGE,
} from '@/lib/scoring';
import { validateCreateLeague } from '@/lib/validation';
import type { Pick, Score } from '@/types';

describe('teamShapeFor', () => {
  it('6-man only when league chose 6 AND the event is a major', () => {
    expect(teamShapeFor({ major_team_size: 6 }, { type: 'major' })).toBe(TEAM_6);
    expect(teamShapeFor({ major_team_size: 6 }, { type: 'regular' })).toBe(TEAM_4);
    expect(teamShapeFor({ major_team_size: 4 }, { type: 'major' })).toBe(TEAM_4);
    expect(teamShapeFor({}, { type: 'major' })).toBe(TEAM_4);   // legacy / missing
  });
  it('shape constants', () => {
    expect(TEAM_6).toEqual({ size: 6, topTier: 3, counting: 4 });
    expect(teamSlots(TEAM_6)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('pickGolferIds trims to the shape', () => {
    const p = { golfer_1_id: 'a', golfer_2_id: 'b', golfer_3_id: 'c', golfer_4_id: 'd',
                golfer_5_id: 'e', golfer_6_id: 'f' };
    expect(pickGolferIds(p, TEAM_4)).toEqual(['a', 'b', 'c', 'd']);
    expect(pickGolferIds(p, TEAM_6)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});

// Field: t1..t5 top tier, d1..d6 dark horse.
const field = [
  ...[1, 2, 3, 4, 5].map(i => ({ id: `t${i}`, name: `Top ${i}`, owgr_rank: i })),
  ...[1, 2, 3, 4, 5, 6].map(i => ({ id: `d${i}`, name: `DH ${i}`, owgr_rank: 40 + i })),
];
const topTierIds = new Set(['t1', 't2', 't3', 't4', 't5']);

describe('validatePick — 6-man', () => {
  const good = ['t1', 't2', 't3', 'd1', 'd2', 'd3'];

  it('accepts 3 top tier + 3 dark horse', () => {
    expect(validatePick({ golferIds: good, golfers: field, topTierIds, existingPicks: [], shape: TEAM_6 }))
      .toEqual([]);
  });

  it('requires all 6', () => {
    const r = validatePick({ golferIds: ['t1', 't2', 't3', 'd1'], golfers: field, topTierIds,
                             existingPicks: [], shape: TEAM_6 });
    expect(r).toEqual(['You must select all 6 golfers.']);
  });

  it('slot 3 must be top tier, slot 4 must be dark horse', () => {
    const r = validatePick({ golferIds: ['t1', 't2', 'd4', 't3', 'd2', 'd3'], golfers: field,
                             topTierIds, existingPicks: [], shape: TEAM_6 });
    expect(r.some(e => e.startsWith('Slot 3 must be a top-tier'))).toBe(true);
    expect(r.some(e => e.startsWith('Slot 4 must be a dark horse'))).toBe(true);
  });

  it('identical 6-set in the league is rejected with 6-golfer wording', () => {
    const r = validatePick({
      golferIds: good, golfers: field, topTierIds, shape: TEAM_6,
      existingPicks: [{ golfer_1_id: 'd3', golfer_2_id: 't3', golfer_3_id: 'd1',
                        golfer_4_id: 't1', golfer_5_id: 'd2', golfer_6_id: 't2' }],
    });
    expect(r).toEqual([expect.stringContaining('combination of 6 golfers')]);
  });

  it('a different set sharing 4 golfers is fine', () => {
    const r = validatePick({
      golferIds: good, golfers: field, topTierIds, shape: TEAM_6,
      existingPicks: [{ golfer_1_id: 't1', golfer_2_id: 't2', golfer_3_id: 't3',
                        golfer_4_id: 'd1', golfer_5_id: 'd2', golfer_6_id: 'd4' }],
    });
    expect(r).toEqual([]);
  });

  it('4-man wording unchanged', () => {
    const r = validatePick({
      golferIds: ['t1', 't2', 'd1', 'd2'], golfers: field, topTierIds,
      existingPicks: [{ golfer_1_id: 't2', golfer_2_id: 't1', golfer_3_id: 'd2', golfer_4_id: 'd1' }],
    });
    expect(r).toEqual([DUPLICATE_FOURSOME_MESSAGE]);
  });
});

function pick6(ids: string[], penalty = 0): Pick {
  return {
    id: 'p', league_id: 'lg', tournament_id: 't', user_id: 'u',
    golfer_1_id: ids[0], golfer_2_id: ids[1], golfer_3_id: ids[2], golfer_4_id: ids[3],
    golfer_5_id: ids[4] ?? null, golfer_6_id: ids[5] ?? null,
    is_locked: true, submitted_at: '', penalty_strokes: penalty,
  } as Pick;
}
function score(golfer_id: string, fantasy_score: number | null, status: Score['status'] = 'active'): Score {
  return { golfer_id, fantasy_score, status, was_replaced: false, replaced_by_golfer_id: null } as Score;
}
const mapOf = (ss: Score[]) => new Map(ss.map(s => [s.golfer_id, s]));

describe('computeLeagueResults — 6-man', () => {
  it('best 4 of 6 count; slots 5/6 scores populated', () => {
    const r = computeLeagueResults(
      [pick6(['a', 'b', 'c', 'd', 'e', 'f'])],
      mapOf([score('a', -4), score('b', 2), score('c', -1), score('d', 5), score('e', -3), score('f', 0)]),
      { shape: TEAM_6 },
    );
    // Best 4: -4, -3, -1, 0 = -8. Dropped: +2, +5.
    expect(r[0].total_score).toBe(-8);
    expect([...r[0].counting_golfers].sort()).toEqual([1, 3, 5, 6]);
    expect(r[0].golfer_5_score).toBe(-3);
    expect(r[0].golfer_6_score).toBe(0);
  });

  it('missed cut: excluded from the best-4 pool, penalty per MC golfer', () => {
    const r = computeLeagueResults(
      [pick6(['a', 'b', 'c', 'd', 'e', 'f'])],
      mapOf([score('a', -4), score('b', -2), score('c', 1, 'missed_cut'),
             score('d', 3), score('e', 1, 'missed_cut'), score('f', 0)]),
      { shape: TEAM_6, missedCutPenalty: 1 },
    );
    // Pool (non-MC): -4, -2, 3, 0 → best 4 = all = -3. Penalty 2×1.
    expect(r[0].total_score).toBe(-3 + 2);
  });

  it('4-man results leave slots 5/6 null', () => {
    const r = computeLeagueResults(
      [pick6(['a', 'b', 'c', 'd'])],
      mapOf([score('a', -1), score('b', 0), score('c', 1), score('d', 2)]),
    );
    expect(r[0].total_score).toBe(0);
    expect(r[0].golfer_5_score).toBeNull();
    expect(r[0].golfer_6_score).toBeNull();
  });
});

describe('buildAutoLineup — 6-man', () => {
  // Pool after excluding the top 1 of each tier: t2..t5 (4), d2..d6 (5).
  const fieldGolfers = field;

  it('builds 3 top-tier + 3 dark-horse, distinct, in slot order', () => {
    const r = buildAutoLineup({ fieldGolfers, topTierIds, takenHashes: new Set(),
                                excludeTopN: 1, shape: TEAM_6, rng: () => 0.5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.golferIds).toHaveLength(6);
    expect(new Set(r.golferIds).size).toBe(6);
    expect(r.golferIds.slice(0, 3).every(id => topTierIds.has(id))).toBe(true);
    expect(r.golferIds.slice(3).every(id => !topTierIds.has(id))).toBe(true);
    expect(r.golferIds).not.toContain('t1');
    expect(r.golferIds).not.toContain('d1');
  });

  it('never returns a taken team (falls through to exhaustive search)', () => {
    const first = buildAutoLineup({ fieldGolfers, topTierIds, takenHashes: new Set(),
                                    excludeTopN: 1, shape: TEAM_6, rng: () => 0 });
    if (!first.ok) throw new Error('expected ok');
    const again = buildAutoLineup({ fieldGolfers, topTierIds, takenHashes: new Set([first.hash]),
                                    excludeTopN: 1, shape: TEAM_6, rng: () => 0, attempts: 3 });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.hash).not.toBe(first.hash);
  });

  it('reports a too-small pool with the 6-man requirement', () => {
    const r = buildAutoLineup({ fieldGolfers, topTierIds, takenHashes: new Set(),
                                excludeTopN: 3, shape: TEAM_6 });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('need ≥3') });
  });
});

describe('computeFoursomeHash + validation', () => {
  it('hash is order-independent for any team size', () => {
    expect(computeFoursomeHash(['f', 'a', 'c', 'b', 'e', 'd'])).toBe('a|b|c|d|e|f');
  });
  it('majorTeamSize must be 4 or 6', () => {
    const base = { name: 'Boys', slug: 'boys', maxPlayers: 10, startDate: '2027-01-01',
                   endDate: '2027-12-31', weeklyBetAmount: 10 };
    expect(validateCreateLeague({ ...base, majorTeamSize: 6 })).toEqual({});
    expect(validateCreateLeague({ ...base, majorTeamSize: 5 }).majorTeamSize).toBeDefined();
  });
});
