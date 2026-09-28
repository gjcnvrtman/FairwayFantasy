import { describe, it, expect } from 'vitest';
import {
  buildScorecardRows,
  defaultScorecardRound,
  parseRoundParam,
  formatToPar,
  type TeamGolferInput,
} from '@/lib/team-scorecard';

const PAR = [4, 4, 3, 5, 4, 4, 3, 4, 5,  4, 4, 3, 5, 4, 4, 3, 4, 5]; // 72

function golfer(p: Partial<TeamGolferInput> & { slot: number }): TeamGolferInput {
  return {
    name: `G${p.slot}`, status: 'active', holesByRound: [null, null, null, null],
    tournamentToPar: null, fantasyScore: null, counting: false, ...p,
  };
}

describe('buildScorecardRows', () => {
  it('full round: OUT/IN/TOT, round to-par, per-hole results', () => {
    const strokes = [...PAR];
    strokes[0] = 3;  // birdie
    strokes[3] = 3;  // eagle on par 5
    strokes[5] = 5;  // bogey
    strokes[6] = 5;  // double on par 3
    const [row] = buildScorecardRows({
      golfers: [golfer({ slot: 1, holesByRound: [strokes, null, null, null] })],
      round: 1, parByHole: PAR,
    });
    expect(row.out).toBe(36 - 1 - 2 + 1 + 2);
    expect(row.in).toBe(36);
    expect(row.total).toBe(72);
    expect(row.roundToPar).toBe(0);
    expect(row.results.slice(0, 7)).toEqual(['birdie', 'par', 'par', 'eagle', 'par', 'bogey', 'double']);
    expect(row.holesPlayed).toBe(18);
  });

  it('round in progress: OUT only when front 9 done, TOT null, to-par over played holes', () => {
    const thru12 = PAR.slice(0, 12).map((p, i) => (i === 10 ? p - 1 : p));
    const [row] = buildScorecardRows({
      golfers: [golfer({ slot: 1, holesByRound: [null, thru12, null, null] })],
      round: 2, parByHole: PAR,
    });
    expect(row.holesPlayed).toBe(12);
    expect(row.out).toBe(36);
    expect(row.in).toBeNull();
    expect(row.total).toBeNull();
    expect(row.roundToPar).toBe(-1);
    expect(row.strokes).toHaveLength(18);
    expect(row.strokes[12]).toBeNull();
  });

  it('no par data: strokes still shown, results + round to-par null', () => {
    const [row] = buildScorecardRows({
      golfers: [golfer({ slot: 1, holesByRound: [[4, 4, 3], null, null, null] })],
      round: 1, parByHole: null,
    });
    expect(row.strokes.slice(0, 3)).toEqual([4, 4, 3]);
    expect(row.results.every(r => r === null)).toBe(true);
    expect(row.roundToPar).toBeNull();
  });

  it('missed-cut golfer has no R3 data — empty row, not an error', () => {
    const [row] = buildScorecardRows({
      golfers: [golfer({ slot: 3, status: 'missed_cut', holesByRound: [PAR, PAR, null, null] })],
      round: 3, parByHole: PAR,
    });
    expect(row.holesPlayed).toBe(0);
    expect(row.roundToPar).toBeNull();
    expect(row.status).toBe('missed_cut');
  });

  it('tier labels: slots 1-2 top tier by default, 1-3 when topTierSlots=3', () => {
    const gs = [1, 2, 3, 4].map(slot => golfer({ slot }));
    expect(buildScorecardRows({ golfers: gs, round: 1, parByHole: PAR }).map(r => r.tierLabel))
      .toEqual(['Top tier', 'Top tier', 'Dark horse', 'Dark horse']);
    expect(buildScorecardRows({ golfers: gs, round: 1, parByHole: PAR, topTierSlots: 3 })[2].tierLabel)
      .toBe('Top tier');
  });

  it('rows come back in slot order and ignore zero/garbage stroke values', () => {
    const rows = buildScorecardRows({
      golfers: [golfer({ slot: 2, holesByRound: [[0, NaN as unknown as number, 4], null, null, null] }), golfer({ slot: 1 })],
      round: 1, parByHole: PAR,
    });
    expect(rows.map(r => r.slot)).toEqual([1, 2]);
    expect(rows[1].strokes.slice(0, 3)).toEqual([null, null, 4]);
  });
});

describe('defaultScorecardRound', () => {
  it('latest round with any data across the team', () => {
    expect(defaultScorecardRound([
      { holesByRound: [PAR, PAR, null, null] },
      { holesByRound: [PAR, PAR, [4, 4], null] },
    ])).toBe(3);
  });
  it('round 1 when nothing played yet', () => {
    expect(defaultScorecardRound([{ holesByRound: [null, null, null, null] }])).toBe(1);
  });
});

describe('parseRoundParam / formatToPar', () => {
  it('parses 1..4, falls back otherwise', () => {
    expect(parseRoundParam('3', 1)).toBe(3);
    expect(parseRoundParam('5', 2)).toBe(2);
    expect(parseRoundParam('abc', 2)).toBe(2);
    expect(parseRoundParam(undefined, 4)).toBe(4);
  });
  it('formats to-par', () => {
    expect(formatToPar(0)).toBe('E');
    expect(formatToPar(3)).toBe('+3');
    expect(formatToPar(-2)).toBe('−2');
    expect(formatToPar(null)).toBe('—');
  });
});
