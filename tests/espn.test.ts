// Tests for src/lib/espn.ts — focused on the scoreboard normalizer.
//
// Why these matter: ESPN's /pga/leaderboard endpoint is currently 404
// for the 2026 PGA Championship, so fetchLiveLeaderboard falls back to
// /pga/scoreboard whose JSON shape differs in 4+ places (athlete name,
// score as raw string, linescores as score-to-par via displayValue,
// missing per-golfer status). normalizeScoreboardCompetitor adapts
// that shape into ESPNCompetitor; this file pins the contract against
// a real captured fixture so regressions surface in CI rather than at
// live-sync time.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeScoreboardCompetitor, parseESPNScore } from '@/lib/espn';

const fixturePath = resolve(__dirname, 'fixtures/espn-pga-championship-round2.json');
const fixture     = JSON.parse(readFileSync(fixturePath, 'utf8'));
const rawCompetitors = fixture.events[0].competitions[0].competitors as any[];

describe('normalizeScoreboardCompetitor — PGA Championship Round 2 fixture', () => {
  it('captures every competitor in the field', () => {
    // PGA Championship's field has 156. If ESPN sends fewer in the
    // fixture, that's news — verify by looking at the file.
    expect(rawCompetitors.length).toBeGreaterThan(100);

    const normalized = rawCompetitors
      .map(normalizeScoreboardCompetitor)
      .filter((c): c is NonNullable<typeof c> => c !== null);

    // The filter drops only competitors with no resolvable name; on
    // a real PGA field every competitor has c.athlete.displayName, so
    // length should match. If this becomes <100, the normalizer is
    // probably stripping legitimate rows.
    expect(normalized.length).toBe(rawCompetitors.length);
  });

  it('resolves displayName from c.athlete (scoreboard has c.displayName=null)', () => {
    const c0 = rawCompetitors[0];
    expect(c0.displayName).toBeFalsy(); // confirm fixture matches what we saw live
    expect(c0.athlete?.displayName).toBeTruthy();

    const n = normalizeScoreboardCompetitor(c0);
    expect(n).not.toBeNull();
    expect(n!.displayName).toBe(c0.athlete.displayName);
  });

  it('wraps the raw-string score into {displayValue, value}', () => {
    const c0 = rawCompetitors[0];
    expect(typeof c0.score).toBe('string'); // scoreboard returns "-3" or "E"

    const n = normalizeScoreboardCompetitor(c0)!;
    expect(n.score.displayValue).toBe(c0.score);
    expect(n.score.value).toBe(parseESPNScore(c0.score));
  });

  it('linescores carry score-to-par (not total strokes) in `value`', () => {
    // Scoreboard's linescores[i].value is total strokes (e.g. 67) and
    // displayValue is score-to-par (e.g. "-3"). The normalizer should
    // unify so `value` carries score-to-par, matching the leaderboard
    // shape and what sync.ts writes into round_N INT columns.
    const c0 = rawCompetitors[0];
    const ls0 = c0.linescores?.[0];
    expect(ls0?.value).toBeGreaterThan(60); // raw is total strokes — high number
    expect(ls0?.displayValue).toBeDefined();

    const n = normalizeScoreboardCompetitor(c0)!;
    expect(n.linescores[0].value).toBe(parseESPNScore(ls0.displayValue));
    // E.g. if displayValue is "-3", normalized value is -3 (not 67).
    expect(Math.abs(n.linescores[0].value)).toBeLessThan(30);
  });

  it('filters out un-played rounds (linescores entries with no value/displayValue)', () => {
    // Find a competitor whose Round 2 might be partial: scoreboard
    // shows entries like {period: 2} with no value when a round hasn't
    // been played. Normalizer drops these so sync.ts gets nulls instead
    // of zeros in round_N columns.
    const hasPartial = rawCompetitors.some((c: any) =>
      (c.linescores ?? []).some((ls: any) =>
        ls?.value === undefined && ls?.displayValue === undefined,
      ),
    );

    if (hasPartial) {
      // Pick one and verify the normalizer drops the empty entries.
      const c = rawCompetitors.find((c: any) =>
        (c.linescores ?? []).some((ls: any) =>
          ls?.value === undefined && ls?.displayValue === undefined,
        ),
      )!;
      const rawLen        = c.linescores.length;
      const playedRawLen  = c.linescores.filter((ls: any) =>
        ls?.value !== undefined || ls?.displayValue !== undefined,
      ).length;
      const n = normalizeScoreboardCompetitor(c)!;
      expect(n.linescores.length).toBe(playedRawLen);
      expect(n.linescores.length).toBeLessThan(rawLen);
    }
    // If no competitor has un-played rounds (e.g. fixture is from
    // post-Round-4), this test is a soft no-op — still meaningful as
    // a guard for future fixtures.
  });

  it('defaults per-golfer status to active (scoreboard has no c.status)', () => {
    const c0 = rawCompetitors[0];
    expect(c0.status).toBeUndefined();

    const n = normalizeScoreboardCompetitor(c0)!;
    expect(n.status.type.name).toBe('active');
  });

  it('returns null when no resolvable name exists', () => {
    const broken = { id: 'x', athlete: undefined, displayName: null };
    expect(normalizeScoreboardCompetitor(broken)).toBeNull();
  });

  it('falls back through athlete.displayName → athlete.fullName → displayName', () => {
    const a = normalizeScoreboardCompetitor({
      id: '1', athlete: { displayName: 'A Name', fullName: 'Ignored' }, score: 'E', linescores: [],
    })!;
    expect(a.displayName).toBe('A Name');

    const b = normalizeScoreboardCompetitor({
      id: '2', athlete: { fullName: 'B Full' }, score: 'E', linescores: [],
    })!;
    expect(b.displayName).toBe('B Full');

    const c = normalizeScoreboardCompetitor({
      id: '3', athlete: undefined, displayName: 'C Fallback', score: 'E', linescores: [],
    })!;
    expect(c.displayName).toBe('C Fallback');
  });

  it('uses c.order when c.sortOrder is missing (scoreboard uses order)', () => {
    const c0 = rawCompetitors[0];
    expect(c0.sortOrder).toBeUndefined();
    expect(typeof c0.order).toBe('number');

    const n = normalizeScoreboardCompetitor(c0)!;
    expect(n.sortOrder).toBe(c0.order);
  });
});
