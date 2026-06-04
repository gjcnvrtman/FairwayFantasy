// Tests for formatThruIndicator — the leaderboard "right-of-score"
// cell formatter. Pure mapping function; mirrors Greg's display spec
// (2026-06-04).

import { describe, it, expect } from 'vitest';
import { formatThruIndicator } from '../src/lib/scoring';

describe('formatThruIndicator — in-round states', () => {
  it('returns "Thru N" for 1..17', () => {
    for (let n = 1; n < 18; n++) {
      expect(formatThruIndicator(n, 'active', 'active')).toBe(`Thru ${n}`);
    }
  });

  it('returns "F" when holes_played === 18 and tournament still active', () => {
    expect(formatThruIndicator(18, 'active', 'active')).toBe('F');
    expect(formatThruIndicator(18, 'active', 'cut_made')).toBe('F');
    expect(formatThruIndicator(18, 'active', 'upcoming')).toBe('F');
  });
});

describe('formatThruIndicator — missing-data states', () => {
  it('returns em-dash for null', () => {
    expect(formatThruIndicator(null, 'active', 'active')).toBe('—');
  });

  it('returns em-dash for 0 (round not started)', () => {
    expect(formatThruIndicator(0, 'active', 'active')).toBe('—');
  });

  it('returns em-dash for undefined (defensive)', () => {
    expect(formatThruIndicator(undefined as unknown as null, 'active', 'active')).toBe('—');
  });
});

describe('formatThruIndicator — out-of-contention statuses', () => {
  it('returns empty for missed_cut', () => {
    expect(formatThruIndicator(18, 'missed_cut', 'active')).toBe('');
    expect(formatThruIndicator(null, 'missed_cut', 'active')).toBe('');
    expect(formatThruIndicator(5,    'missed_cut', 'cut_made')).toBe('');
  });

  it('returns empty for withdrawn', () => {
    expect(formatThruIndicator(10, 'withdrawn', 'active')).toBe('');
    expect(formatThruIndicator(null, 'withdrawn', 'active')).toBe('');
  });

  it('returns empty for disqualified', () => {
    expect(formatThruIndicator(7, 'disqualified', 'active')).toBe('');
  });

  it('returns empty for complete', () => {
    expect(formatThruIndicator(18, 'complete', 'active')).toBe('');
  });
});

describe('formatThruIndicator — tournament-complete state', () => {
  it('returns empty when tournament is complete, regardless of golfer status', () => {
    expect(formatThruIndicator(18, 'active', 'complete')).toBe('');
    expect(formatThruIndicator(5,  'active', 'complete')).toBe('');
    expect(formatThruIndicator(null, 'active', 'complete')).toBe('');
    expect(formatThruIndicator(0,  'missed_cut', 'complete')).toBe('');
  });
});

// ── normalizeScoreboardCompetitor derivation (the actual ESPN-shape path) ──
import { normalizeScoreboardCompetitor } from '../src/lib/espn';

describe('normalizeScoreboardCompetitor — derives thru from inner linescores', () => {
  it('picks the in-progress round when a future-round placeholder exists', () => {
    // This is the exact shape ESPN's scoreboard endpoint returned for The
    // Memorial on 2026-06-04 mid-R1: an outer entry for R1 with 9 holes
    // scored, AND an outer entry for R2 with empty inner linescores
    // (placeholder for the upcoming round). The naive "highest period"
    // strategy would land on R2 → thru=0; the correct answer is R1 → thru=9.
    const c = {
      id: '123',
      athlete: { displayName: 'Test Golfer' },
      score: '-3',
      status: null,
      linescores: [
        {
          period: 1, value: 33.0, displayValue: '-3',
          linescores: Array.from({ length: 9 }, (_, i) => ({
            value: 4, displayValue: '4', period: 1,
          })),
        },
        // R2 placeholder — ESPN includes this once R1 starts
        { period: 2, value: null, linescores: [] },
      ],
    };
    const out = normalizeScoreboardCompetitor(c);
    expect(out).not.toBeNull();
    expect(out!.status.thru).toBe(9);
    expect(out!.status.currentRound).toBe(1);
  });

  it('derives thru=18 / currentRound=2 when R1 is done and R2 is complete', () => {
    const c = {
      id: '123',
      athlete: { displayName: 'Test Golfer' },
      score: '-3',
      status: null,
      linescores: [
        { period: 1, value: 67, linescores: Array.from({length: 18}, () => ({value: 4, displayValue: '4', period: 1})) },
        { period: 2, value: 68, linescores: Array.from({length: 18}, () => ({value: 4, displayValue: '4', period: 2})) },
      ],
    };
    const out = normalizeScoreboardCompetitor(c);
    expect(out!.status.thru).toBe(18);
    expect(out!.status.currentRound).toBe(2);
  });

  it('returns null thru when no round has any holes scored yet', () => {
    const c = {
      id: '123',
      athlete: { displayName: 'Test Golfer' },
      score: 'E',
      status: null,
      linescores: [
        { period: 1, value: null, linescores: [] },
      ],
    };
    const out = normalizeScoreboardCompetitor(c);
    expect(out!.status.thru).toBeNull();
    expect(out!.status.currentRound).toBeNull();
  });

  it('falls through when c.linescores is empty', () => {
    const c = {
      id: '123',
      athlete: { displayName: 'Test Golfer' },
      score: 'E',
      status: null,
      linescores: [],
    };
    const out = normalizeScoreboardCompetitor(c);
    expect(out!.status.thru).toBeNull();
  });

  it('caps thru at 18 if ESPN ever returns >18 inner entries (defensive)', () => {
    const c = {
      id: '123',
      athlete: { displayName: 'Test Golfer' },
      score: '-3',
      status: null,
      linescores: [{
        period: 1, value: 60,
        linescores: Array.from({length: 25}, () => ({value: 4, displayValue: '4', period: 1})),
      }],
    };
    const out = normalizeScoreboardCompetitor(c);
    expect(out!.status.thru).toBe(18);
  });
});

describe('formatThruIndicator — defensive bounds', () => {
  it('returns em-dash for out-of-range values (shouldn\'t happen given DB CHECK)', () => {
    expect(formatThruIndicator(-1, 'active', 'active')).toBe('—');
    expect(formatThruIndicator(19, 'active', 'active')).toBe('—');
    expect(formatThruIndicator(100, 'active', 'active')).toBe('—');
  });

  it('treats null/undefined golfer status as in-contention', () => {
    expect(formatThruIndicator(5, null, 'active')).toBe('Thru 5');
    expect(formatThruIndicator(5, undefined, 'active')).toBe('Thru 5');
  });

  it('treats null/undefined tournament status as not-complete', () => {
    expect(formatThruIndicator(5, 'active', null)).toBe('Thru 5');
    expect(formatThruIndicator(5, 'active', undefined)).toBe('Thru 5');
  });
});
