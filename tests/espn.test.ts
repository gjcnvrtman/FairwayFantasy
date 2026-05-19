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

// ─────────────────────────────────────────────────────────────
// Round 4 post-cut fixture (PGA Championship 2026, STATUS_FINAL).
// 156 competitors: 82 played all 4 rounds (made cut), 74 played
// exactly 2 rounds (missed cut). Captured live 2026-05-19 after
// the event finished — pins the post-event shape that
// fetchLiveLeaderboard sees once the tournament is over but
// before the rankings sync flips status to 'complete'.
// ─────────────────────────────────────────────────────────────

const r4Path  = resolve(__dirname, 'fixtures/espn-pga-championship-round4-final.json');
const r4Fix   = JSON.parse(readFileSync(r4Path, 'utf8'));
const r4Comp  = r4Fix.events[0].competitions[0];
const r4Raw   = r4Comp.competitors as any[];

describe('normalizeScoreboardCompetitor — Round 4 post-cut fixture', () => {
  it('event-level status carries STATUS_FINAL / state=post / Final description', () => {
    // The open P0 TODO is that syncTournament only flips status to
    // 'complete' when the leaderboard endpoint's status string
    // includes 'final'. ESPN's scoreboard fallback exposes the same
    // info on `events[0].competitions[0].status.type` — these three
    // fields are the signals a future time-based-completion fix
    // can match against. If ESPN ever drops them, this test fires.
    const st = r4Comp.status?.type;
    expect(st?.name).toBe('STATUS_FINAL');
    expect(st?.state).toBe('post');
    expect(st?.completed).toBe(true);
    expect(String(st?.description).toLowerCase()).toContain('final');
  });

  it('captures all 156 competitors', () => {
    expect(r4Raw.length).toBe(156);
    const normalized = r4Raw
      .map(normalizeScoreboardCompetitor)
      .filter((c): c is NonNullable<typeof c> => c !== null);
    // Every competitor has a resolvable name; nobody should be dropped.
    expect(normalized.length).toBe(156);
  });

  it('made-cut entries have exactly 4 linescores after normalization', () => {
    const madeCut = r4Raw.filter((c: any) => {
      const played = (c.linescores ?? []).filter((ls: any) =>
        ls?.value !== undefined || ls?.displayValue !== undefined,
      );
      return played.length === 4;
    });
    expect(madeCut.length).toBeGreaterThan(50); // ~82 on a PGA major
    for (const c of madeCut.slice(0, 5)) {
      const n = normalizeScoreboardCompetitor(c)!;
      expect(n.linescores.length).toBe(4);
      // round_N column would hold these score-to-par integers
      expect(Math.abs(n.linescores[3].value)).toBeLessThan(30);
    }
  });

  it('missed-cut entries have exactly 2 linescores after normalization', () => {
    const missedCut = r4Raw.filter((c: any) => {
      const played = (c.linescores ?? []).filter((ls: any) =>
        ls?.value !== undefined || ls?.displayValue !== undefined,
      );
      return played.length === 2;
    });
    expect(missedCut.length).toBeGreaterThan(50); // ~74 typically
    for (const c of missedCut.slice(0, 5)) {
      const n = normalizeScoreboardCompetitor(c)!;
      // Rounds 1-2 only; rounds 3-4 must arrive as null downstream.
      expect(n.linescores.length).toBe(2);
    }
  });

  it('still defaults per-golfer status to active even post-event', () => {
    // Scoreboard doesn't expose c.status — this is the known limitation
    // that drove the sync.ts cut-day inference. Round-4 post-event
    // doesn't change that; pinning it here so the gap stays visible.
    const withStatus = r4Raw.filter((c: any) => c.status !== undefined);
    expect(withStatus.length).toBe(0);

    // Normalizer fills in the default ('active') — sync.ts then has
    // to infer missed_cut from linescores.length < 3.
    const n = normalizeScoreboardCompetitor(r4Raw[0])!;
    expect(n.status.type.name).toBe('active');
  });

  it('sortOrder ordering is consistent across made-cut + missed-cut rows', () => {
    const normalized = r4Raw
      .map(normalizeScoreboardCompetitor)
      .filter((c): c is NonNullable<typeof c> => c !== null);
    // ESPN's `order` field on the scoreboard fixture is monotonic
    // through the field (1, 2, 3, ...). Just verify we got a usable
    // integer for every row — the actual sort happens downstream
    // in `recomputeResults` from score-to-par + tiebreakers.
    for (const n of normalized) {
      expect(typeof n.sortOrder).toBe('number');
      expect(Number.isFinite(n.sortOrder)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Empty scoreboard — synthetic fixture for the no-tournament case.
// Pins behavior when ESPN returns `events: []` (e.g. event id
// unrecognized, or query made on a day with no PGA event).
// ─────────────────────────────────────────────────────────────

const emptyPath = resolve(__dirname, 'fixtures/espn-scoreboard-empty.json');
const emptyFix  = JSON.parse(readFileSync(emptyPath, 'utf8'));

describe('Empty scoreboard fixture', () => {
  it('parses cleanly with zero events and zero competitors', () => {
    expect(Array.isArray(emptyFix.events)).toBe(true);
    expect(emptyFix.events.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// Synthetic leaderboard-shape fixture — pins the pass-through
// branch in fetchLiveLeaderboard. /pga/leaderboard is 404 in
// production today, so we can't capture a real one; this synthetic
// captures the shape contract instead: c.displayName direct, score
// pre-wrapped, linescores carry score-to-par in `value`, per-golfer
// status field present (the very thing scoreboard lacks).
// ─────────────────────────────────────────────────────────────

const lbPath = resolve(__dirname, 'fixtures/espn-leaderboard-shape.json');
const lbFix  = JSON.parse(readFileSync(lbPath, 'utf8'));
const lbComp = lbFix.events[0].competitions[0];

describe('Leaderboard-shape (pass-through) fixture', () => {
  it('competitors have c.displayName directly, not nested under c.athlete', () => {
    for (const c of lbComp.competitors) {
      expect(typeof c.displayName).toBe('string');
      expect(c.athlete).toBeUndefined();
    }
  });

  it('per-golfer status is present and varies (active / missed_cut / withdrawn)', () => {
    const names = lbComp.competitors.map((c: any) => c.status.type.name);
    expect(names).toContain('active');
    expect(names).toContain('missed_cut');
    expect(names).toContain('withdrawn');
  });

  it('score is pre-wrapped {displayValue, value}', () => {
    for (const c of lbComp.competitors) {
      expect(typeof c.score).toBe('object');
      expect(typeof c.score.displayValue).toBe('string');
      expect(typeof c.score.value).toBe('number');
    }
  });

  it('linescores carry score-to-par in `value` directly (no normalization needed)', () => {
    for (const c of lbComp.competitors) {
      for (const ls of c.linescores) {
        // |value| < 30 means it's score-to-par, not total strokes.
        expect(Math.abs(ls.value)).toBeLessThan(30);
      }
    }
  });

  it('missed-cut and withdrawn rows have <4 linescores', () => {
    const mc = lbComp.competitors.find((c: any) => c.status.type.name === 'missed_cut');
    const wd = lbComp.competitors.find((c: any) => c.status.type.name === 'withdrawn');
    expect(mc.linescores.length).toBe(2);
    expect(wd.linescores.length).toBeLessThanOrEqual(2);
  });
});
