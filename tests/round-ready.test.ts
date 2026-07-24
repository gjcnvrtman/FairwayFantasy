// Tests for isRoundReadyForScorecard — the per-round completeness gate
// for the daily-scorecard email.
//
// Rewritten 2026-07-24 alongside the gate: the signal is now the
// 18-element `round_N_holes` array, not the round total. Prior gates
// keyed off `round_N != null`, which fired the moment ESPN populated
// the in-flight round's cumulative-strokes-so-far counter (typically
// as the leaders teed off round N+1) — mis-firing R2 scorecards on
// 2026-07-24 with 7-strokes-through-2 totals rendered as finals.

import { describe, it, expect } from 'vitest';
import { isRoundReadyForScorecard } from '@/lib/sync';

// Any 18-length int array counts as "round complete" — the values
// themselves aren't what the gate examines.
const FULL: number[]    = [4,4,3,4,4,3,4,4,4, 4,4,3,4,4,3,4,4,4];
// Partial round in progress — e.g., 7 holes played, 11 to go.
const PARTIAL: number[] = [4,4,3,4,4,3,4];

const make = (status: string, roundHoles: number[] | null) => ({ status, roundHoles });

describe('isRoundReadyForScorecard — happy path', () => {
  it('fires when every cut survivor has a full 18-hole scorecard', () => {
    const ready = isRoundReadyForScorecard({
      expectedPlayers: [
        make('active', FULL),
        make('active', FULL),
        make('active', FULL),
      ],
    });
    expect(ready).toBe(true);
  });

  it('counts status="complete" alongside "active" (both are cut survivors)', () => {
    const ready = isRoundReadyForScorecard({
      expectedPlayers: [
        make('active',   FULL),
        make('complete', FULL),
      ],
    });
    expect(ready).toBe(true);
  });
});

describe('isRoundReadyForScorecard — does NOT fire on partial completion', () => {
  it('one cut survivor still on course → does not fire', () => {
    const ready = isRoundReadyForScorecard({
      expectedPlayers: [
        make('active', FULL),
        make('active', PARTIAL),  // late group, still playing
        make('active', FULL),
      ],
    });
    expect(ready).toBe(false);
  });

  it('majority finished but one straggler → does not fire', () => {
    const expectedPlayers = Array.from({ length: 60 }, (_, i) =>
      make('active', i === 59 ? PARTIAL : FULL));
    expect(isRoundReadyForScorecard({ expectedPlayers })).toBe(false);
  });

  it('early starters posted, late groups have no holes yet → does not fire', () => {
    const ready = isRoundReadyForScorecard({
      expectedPlayers: [
        make('active', FULL),     // early starter, finished R4
        make('active', null),     // late group, not even teed off
        make('active', null),
        make('active', null),
        make('active', null),
      ],
    });
    expect(ready).toBe(false);
  });

  it('regression 2026-07-24 — round in flight with cumulative-so-far data still blocks', () => {
    // The failure mode that motivated this rewrite: ESPN's
    // linescores[N-1].value returns cumulative strokes for the
    // in-flight round. If we naively saved that as the round total,
    // the old gate would fire. The holes-array gate correctly ignores
    // it because the inner per-hole array is still under 18.
    const ready = isRoundReadyForScorecard({
      expectedPlayers: [
        make('active', PARTIAL),
        make('active', PARTIAL),
        make('active', PARTIAL),
      ],
    });
    expect(ready).toBe(false);
  });
});

describe('isRoundReadyForScorecard — excluded statuses', () => {
  it('missed_cut / withdrawn / disqualified golfers are NOT cut survivors and dont gate the round', () => {
    // R3 readiness: an MC golfer has round_3_holes = null because
    // they're not playing. Should not block the round from firing.
    const ready = isRoundReadyForScorecard({
      expectedPlayers: [
        make('active', FULL),
        make('active', FULL),
        make('missed_cut',   null),
        make('withdrawn',    null),
        make('disqualified', null),
      ],
    });
    expect(ready).toBe(true);
  });

  it('field with only non-survivors → does not fire (no one to send for)', () => {
    const ready = isRoundReadyForScorecard({
      expectedPlayers: [
        make('missed_cut', null),
        make('withdrawn',  null),
      ],
    });
    expect(ready).toBe(false);
  });

  it('empty field → does not fire (gracefully handles pre-tournament state)', () => {
    expect(isRoundReadyForScorecard({ expectedPlayers: [] })).toBe(false);
  });
});

describe('isRoundReadyForScorecard — holes-array edge cases', () => {
  it('round total may exist without full holes — still blocks', () => {
    // If a data pipeline populates only the aggregate but not the
    // per-hole array, the gate should refuse to fire. This is safer
    // than sending an email whose per-hole heatmap would be blank.
    const ready = isRoundReadyForScorecard({
      expectedPlayers: [
        make('active', null),
        make('active', null),
      ],
    });
    expect(ready).toBe(false);
  });

  it('exactly 18 holes fires; 17 does not', () => {
    const seventeen = [4,4,3,4,4,3,4,4,4, 4,4,3,4,4,3,4,4];
    expect(isRoundReadyForScorecard({
      expectedPlayers: [make('active', seventeen)],
    })).toBe(false);
    expect(isRoundReadyForScorecard({
      expectedPlayers: [make('active', FULL)],
    })).toBe(true);
  });
});
