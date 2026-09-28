// predictionsReadyEmail — foursomes section, plus the six-man section
// when a run has 6-man major teams (migration 029).

import { describe, it, expect } from 'vitest';
import { predictionsReadyEmail, type PredictionsEmailFoursome } from '@/lib/email';

const team = (rank: number, size: 4 | 6): PredictionsEmailFoursome => ({
  rank, teamSize: size,
  topTier1Name: `T1-${size}-${rank}`, topTier2Name: `T2-${size}-${rank}`,
  topTier3Name: size === 6 ? `T3-${size}-${rank}` : null,
  darkHorse1Name: `D1-${size}-${rank}`, darkHorse2Name: `D2-${size}-${rank}`,
  darkHorse3Name: size === 6 ? `D3-${size}-${rank}` : null,
  projectedScore: -10, confidence: 0.8, riskLevel: 'balanced', ownership: null,
  explanation: null, keyStrengths: [], keyConcerns: [],
});
const build = (foursomes: PredictionsEmailFoursome[]) => predictionsReadyEmail({
  recipientName: 'Greg', tournamentName: 'The Open', courseName: null, asOfDate: '2027-07-14',
  foursomes, fieldSize: 156, golfersWithMissingStats: 0, missingInputsByField: {},
  siteUrl: 'https://x.test', runId: 'run-1',
});

describe('predictionsReadyEmail', () => {
  it('foursomes only: unchanged subject, no six-man section', () => {
    const e = build([1, 2].map(r => team(r, 4)));
    expect(e.subject).toBe('Top 5 predicted foursomes — The Open');
    expect(e.text).not.toMatch(/SIX-MAN/);
    expect(e.html).not.toMatch(/six-man/i);
    expect(e.text).toContain('Top-tier:   T1-4-1, T2-4-1');
  });

  it('with six-man teams: second section listing all three per tier', () => {
    const e = build([team(1, 4), team(1, 6)]);
    expect(e.subject).toBe('Top 5 predicted foursomes + six-man teams — The Open');
    expect(e.text).toMatch(/TOP 5 SIX-MAN TEAMS/);
    expect(e.text).toContain('Top-tier:   T1-6-1, T2-6-1, T3-6-1');
    expect(e.text).toContain('Dark horse: D1-6-1, D2-6-1, D3-6-1');
    expect(e.text.indexOf('T1-4-1')).toBeLessThan(e.text.indexOf('SIX-MAN'));
    expect(e.html).toContain('Top 5 six-man teams');
    expect(e.html).toContain('T3-6-1');
  });
});
