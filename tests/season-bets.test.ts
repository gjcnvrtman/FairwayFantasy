import { describe, it, expect } from 'vitest';
import {
  assignSeasons, golferContribution, teamContributions, computeSeasonStandings,
  settleCumulativeBet, detectAces, applyAceAdjustments, settleAceBounties,
  seasonBetConfigFromLeague, hasSeasonBets,
  type SeasonBetConfig, type TeamEntry,
} from '@/lib/season-bets';

const cfg = (over: Partial<SeasonBetConfig> = {}): SeasonBetConfig => ({
  seasonCount: 1,
  amounts: { team: 10, topTier: null, darkHorse: null },
  addPenalties: false, missedCutPenalty: 1, aceBounty: null, ...over,
});

const sum = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + v, 0);

describe('assignSeasons', () => {
  const ev = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`, start_date: new Date(Date.UTC(2027, 0, 1 + i * 7)).toISOString(),
  }));
  it('26 events / 4 seasons → 7, 7, 6, 6 in date order, extras first', () => {
    const s = assignSeasons(ev(26), 4);
    expect(s.map(x => x.tournaments.length)).toEqual([7, 7, 6, 6]);
    expect(s[0].tournaments[0].id).toBe('t1');
    expect(s[1].tournaments[0].id).toBe('t8');
    expect(s[3].tournaments[5].id).toBe('t26');
  });
  it('1 season = everything; 2 = halves', () => {
    expect(assignSeasons(ev(26), 1)[0].tournaments).toHaveLength(26);
    expect(assignSeasons(ev(26), 2).map(x => x.tournaments.length)).toEqual([13, 13]);
  });
  it('sorts by start date even when given out of order', () => {
    const s = assignSeasons([...ev(4)].reverse(), 2);
    expect(s[0].tournaments.map(t => t.id)).toEqual(['t1', 't2']);
  });
  it('fewer events than seasons drops the empty ones', () => {
    expect(assignSeasons(ev(2), 4).map(x => x.season)).toEqual([1, 2]);
  });
});

describe('golfer + team contributions', () => {
  it('made cut uses the event score; missed cut uses score through the cut', () => {
    expect(golferContribution({ slot: 1, status: 'complete', fantasyScore: -6, scoreToPar: -8 }, cfg())).toBe(-6);
    expect(golferContribution({ slot: 1, status: 'missed_cut', fantasyScore: 1, scoreToPar: 5 }, cfg())).toBe(5);
  });
  it('dropouts count like a missed cut without the penalty', () => {
    const c = cfg({ addPenalties: true, missedCutPenalty: 2 });
    expect(golferContribution({ slot: 1, status: 'missed_cut',   fantasyScore: 2,    scoreToPar: 5 }, c)).toBe(7);
    expect(golferContribution({ slot: 1, status: 'withdrawn',    fantasyScore: null, scoreToPar: 5 }, c)).toBe(5);
    expect(golferContribution({ slot: 1, status: 'disqualified', fantasyScore: null, scoreToPar: 5 }, c)).toBe(5);
    // WD before teeing off: nothing to add.
    expect(golferContribution({ slot: 1, status: 'withdrawn',    fantasyScore: null, scoreToPar: null }, c)).toBe(0);
  });
  it('add penalties: +MC penalty per MC golfer, +missed-deadline on team bet only', () => {
    const c = cfg({ addPenalties: true, missedCutPenalty: 2 });
    const entry: TeamEntry = {
      userId: 'u', topTierSlots: 2, pickPenalty: 2,
      golfers: [
        { slot: 1, status: 'complete',   fantasyScore: -5, scoreToPar: -5 },
        { slot: 2, status: 'missed_cut', fantasyScore: 1,  scoreToPar: 4 },
        { slot: 3, status: 'complete',   fantasyScore: 1,  scoreToPar: 1 },
        { slot: 4, status: 'withdrawn',  fantasyScore: null, scoreToPar: 3 },
      ],
    };
    // top: -5 + (4+2) = 1; dark: 1 + 3 = 4; team: 5 + 2 deadline = 7
    expect(teamContributions(entry, c)).toEqual({ team: 7, topTier: 1, darkHorse: 4 });
    // penalties off: top -1, dark 4, team 3
    expect(teamContributions(entry, cfg())).toEqual({ team: 3, topTier: -1, darkHorse: 4 });
  });
  it('6-man majors: 3 top-tier slots', () => {
    const entry: TeamEntry = {
      userId: 'u', topTierSlots: 3, pickPenalty: 0,
      golfers: [1, 2, 3, 4, 5, 6].map(slot => ({ slot, status: 'complete', fantasyScore: slot, scoreToPar: slot })),
    };
    expect(teamContributions(entry, cfg())).toEqual({ team: 21, topTier: 6, darkHorse: 15 });
  });
});

describe('computeSeasonStandings + settleCumulativeBet', () => {
  const members = [
    { user_id: 'a', joined_at: '2027-01-01' },
    { user_id: 'b', joined_at: '2027-01-01' },
    { user_id: 'c', joined_at: '2027-01-01' },
    { user_id: 'late', joined_at: '2027-03-01' },
  ];
  const e = (userId: string, s: number): TeamEntry => ({
    userId, topTierSlots: 2, pickPenalty: 0,
    golfers: [{ slot: 1, status: 'complete', fantasyScore: s, scoreToPar: s }],
  });
  const tournaments = [
    { lockedAt: '2027-01-10', entries: [e('a', -3), e('b', 0), e('c', 2)] },
    { lockedAt: '2027-03-10', entries: [e('a', 1), e('b', -5), e('c', 0), e('late', -20)] },
  ];

  it('sums across the season; late joiner excluded', () => {
    const s = computeSeasonStandings({ members, tournaments, cfg: cfg() });
    expect(s.eligible).toEqual(['a', 'b', 'c']);
    expect(s.totals.team.get('a')).toBe(-2);
    expect(s.totals.team.get('b')).toBe(-5);
    expect(s.totals.team.has('late')).toBe(false);
  });

  it('everyone bets the amount; winner takes the whole pot; zero-sum', () => {
    const s = computeSeasonStandings({ members, tournaments, cfg: cfg() });
    const d = settleCumulativeBet(s.eligible, s.totals.team, 10);
    expect(d.get('b')).toBe(30 - 10);   // pot $30, nets +$20
    expect(d.get('a')).toBe(-10);
    expect(d.get('c')).toBe(-10);
    expect(sum(d)).toBe(0);
  });

  it("Greg's example: $10 × 20 players → winner nets +$190", () => {
    const eligible = Array.from({ length: 20 }, (_, i) => `p${i}`);
    const totals = new Map(eligible.map((u, i) => [u, i]));   // p0 lowest
    const d = settleCumulativeBet(eligible, totals, 10);
    expect(d.get('p0')).toBe(190);
    expect(d.get('p7')).toBe(-10);
    expect(sum(d)).toBe(0);
  });

  it('tie for lowest splits the pot', () => {
    const d = settleCumulativeBet(['a', 'b', 'c'], new Map([['a', -4], ['b', -4], ['c', 0]]), 10);
    expect(d.get('a')).toBe(15 - 10);
    expect(d.get('b')).toBe(15 - 10);
    expect(d.get('c')).toBe(-10);
    expect(sum(d)).toBe(0);
  });

  it('fewer than 2 eligible members → no money moves', () => {
    expect(settleCumulativeBet(['a'], new Map([['a', -4]]), 10).get('a')).toBe(0);
  });
});

describe('aces', () => {
  it('detects holes played in one stroke', () => {
    expect(detectAces('g', [[4, 1, 3], null, [3, 3, 1]])).toEqual([
      { golferId: 'g', round: 1, hole: 2 },
      { golferId: 'g', round: 3, hole: 3 },
    ]);
  });
  it('adjustments add missed aces and void bad ones', () => {
    const detected = [{ golferId: 'g', round: 1, hole: 2 }];
    const r = applyAceAdjustments(detected, [
      { golferId: 'g', round: 1, hole: 2, action: 'void' },
      { golferId: 'h', round: 4, hole: 16, action: 'add' },
    ]);
    expect(r).toEqual([{ golferId: 'h', round: 4, hole: 16 }]);
  });
  it('bounty: owner collects from every other member per ace; zero-sum', () => {
    const d = settleAceBounties(['a', 'b', 'c', 'd'], new Map([['a', 1], ['c', 2]]), 5);
    // a: +15 -10 = +5; c: +30 -5 = +25; b: -5 -10 = -15; d: -15
    expect(d.get('a')).toBe(5);
    expect(d.get('c')).toBe(25);
    expect(d.get('b')).toBe(-15);
    expect(d.get('d')).toBe(-15);
    expect(sum(d)).toBe(0);
  });
  it('owner outside the eligible set is ignored', () => {
    const d = settleAceBounties(['a', 'b'], new Map([['zz', 3]]), 5);
    expect(sum(d)).toBe(0);
    expect(d.get('a')).toBe(0);
  });
});

describe('config', () => {
  it('reads league columns; NULL bets are off', () => {
    const c = seasonBetConfigFromLeague({
      season_count: 2, bet_team_cumulative: '50.00', bet_top_tier_cumulative: null,
      bet_dark_horse_cumulative: '25.00', bets_add_penalties: true, bet_ace_bounty: null,
      missed_cut_penalty: 1,
    });
    expect(c.amounts).toEqual({ team: 50, topTier: null, darkHorse: 25 });
    expect(hasSeasonBets(c)).toBe(true);
    expect(hasSeasonBets(seasonBetConfigFromLeague({}))).toBe(false);
  });
});
