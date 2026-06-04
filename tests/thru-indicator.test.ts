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
