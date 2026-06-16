// Tests for isRoundReadyForScorecard — the per-round completeness gate
// for the daily-scorecard email. Tightened 2026-06-16 from "any
// expected player has a round_N total" to "every expected player has
// one", to handle rounds that bleed into the next day due to rain
// delays without sending half-baked day-of leaderboards.

import { describe, it, expect } from 'vitest';
import { isRoundReadyForScorecard } from '@/lib/sync';

const make = (status: string, roundTotal: number | null) => ({ status, roundTotal });

describe('isRoundReadyForScorecard — happy path', () => {
  it('fires when every cut survivor has a round total', () => {
    const ready = isRoundReadyForScorecard({
      expectedPlayers: [
        make('active', -3),
        make('active',  0),
        make('active', +2),
      ],
    });
    expect(ready).toBe(true);
  });

  it('counts status="complete" alongside "active" (both are cut survivors)', () => {
    const ready = isRoundReadyForScorecard({
      expectedPlayers: [
        make('active',  -2),
        make('complete', -5),
      ],
    });
    expect(ready).toBe(true);
  });
});

describe('isRoundReadyForScorecard — does NOT fire on partial completion', () => {
  it('one cut survivor still on course → does not fire', () => {
    const ready = isRoundReadyForScorecard({
      expectedPlayers: [
        make('active', -3),
        make('active', null),  // late group, not finished
        make('active', +1),
      ],
    });
    expect(ready).toBe(false);
  });

  it('majority finished but one straggler → does not fire', () => {
    const expectedPlayers = Array.from({ length: 60 }, (_, i) =>
      make('active', i === 59 ? null : -1));
    expect(isRoundReadyForScorecard({ expectedPlayers })).toBe(false);
  });

  it('regression for 2026-06-14 RBC scenario — early starters posted, late groups null', () => {
    // The 09:40 CDT Sunday snapshot: a couple early-tee-time golfers
    // had R4 values, but most of the field still hadn't started.
    // Old "any" gate would have fired immediately; new "all" gate
    // correctly skips until everyone's finished.
    const ready = isRoundReadyForScorecard({
      expectedPlayers: [
        make('active', -1),     // early starter, finished R4
        make('active', null),   // late group, not even teed off
        make('active', null),
        make('active', null),
        make('active', null),
      ],
    });
    expect(ready).toBe(false);
  });
});

describe('isRoundReadyForScorecard — excluded statuses', () => {
  it('missed_cut / withdrawn / disqualified golfers are NOT cut survivors and dont gate the round', () => {
    // R3 readiness: an MC golfer has round_3 = null because they're
    // not playing. Should not block the round from firing.
    const ready = isRoundReadyForScorecard({
      expectedPlayers: [
        make('active', -2),
        make('active', +1),
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

describe('isRoundReadyForScorecard — scores of 0 / E are valid round totals', () => {
  it('0 (shot par) counts as a finished round, not "missing"', () => {
    // Critical: this is what distinguished a real R4 of E from a
    // not-yet-played R4. We check `!= null`, not truthiness.
    const ready = isRoundReadyForScorecard({
      expectedPlayers: [
        make('active', -3),
        make('active',  0),  // shot par — legit finished round
        make('active', +4),
      ],
    });
    expect(ready).toBe(true);
  });
});
