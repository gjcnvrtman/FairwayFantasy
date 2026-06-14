// Tests for buildAutoLineup — the missed-deadline auto-assign helper
// in src/lib/scoring.ts.
//
// Pure-logic tests (no DB). buildAutoLineup is the part of the
// auto-assign sweep that picks a valid, unique 4-golfer set; the
// surrounding DB I/O (find missed users, insert pick, send email)
// lives in sync.ts and is covered by the integration smoke at deploy
// time, not here.

import { describe, it, expect } from 'vitest';
import {
  buildAutoLineup,
  computeFoursomeHash,
  AUTO_LINEUP_EXCLUDE_TOP_N,
} from '../src/lib/scoring';

// Build a synthetic field with N top-tier + M dark-horse golfers.
// Names + ids are deterministic ("top-1".."top-N", "dark-1".."dark-M")
// and owgr_rank tracks position within tier so assertions about which
// names got excluded are easy to write.
//
// Returns the golfer list AND the topTierIds Set buildAutoLineup
// expects — the set is simply {top-1..top-N}, mirroring what
// computeTopTierIds would return on this synthetic field.
function makeField(opts: { tops: number; darks: number }): {
  golfers: Array<{ id: string; name: string; owgr_rank: number | null }>;
  topTierIds: Set<string>;
} {
  const golfers: Array<{ id: string; name: string; owgr_rank: number | null }> = [];
  const topTierIds = new Set<string>();
  for (let i = 1; i <= opts.tops; i++) {
    golfers.push({ id: `top-${i}`, name: `Top ${i}`, owgr_rank: i });
    topTierIds.add(`top-${i}`);
  }
  for (let i = 1; i <= opts.darks; i++) {
    // dark horses start at OWGR 25.
    golfers.push({ id: `dark-${i}`, name: `Dark ${i}`, owgr_rank: 24 + i });
  }
  return { golfers, topTierIds };
}

// Seeded deterministic RNG so test results don't drift.
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // xorshift32 — good enough for shuffle determinism.
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

describe('computeFoursomeHash', () => {
  it('is order-independent (matches Postgres trigger semantics)', () => {
    const a = computeFoursomeHash(['a', 'b', 'c', 'd']);
    const b = computeFoursomeHash(['d', 'b', 'c', 'a']);
    const c = computeFoursomeHash(['c', 'd', 'a', 'b']);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('uses pipe delimiter', () => {
    expect(computeFoursomeHash(['x', 'y', 'z', 'w'])).toBe('w|x|y|z');
  });
});

describe('buildAutoLineup — pool sizing', () => {
  it('fails gracefully when top-tier pool has < 2 after exclusion', () => {
    // 5 tops, exclude top 4 → pool of 1 → insufficient.
    const field = makeField({ tops: 5, darks: 30 });
    const r = buildAutoLineup({
      fieldGolfers: field.golfers, topTierIds: field.topTierIds,
      takenHashes: new Set(), rng: seededRng(1),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/top-tier pool too small/);
  });

  it('fails gracefully when dark-horse pool has < 2 after exclusion', () => {
    const field = makeField({ tops: 30, darks: 5 });
    const r = buildAutoLineup({
      fieldGolfers: field.golfers, topTierIds: field.topTierIds,
      takenHashes: new Set(), rng: seededRng(1),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/dark-horse pool too small/);
  });

  it('succeeds with the minimum viable field (6 of each tier)', () => {
    // exclude top 4 of each → pool of 2 each → exactly one combo possible.
    const field = makeField({ tops: 6, darks: 6 });
    const r = buildAutoLineup({
      fieldGolfers: field.golfers, topTierIds: field.topTierIds,
      takenHashes: new Set(), rng: seededRng(1),
    });
    expect(r.ok).toBe(true);
  });
});

describe('buildAutoLineup — exclusion of top-N by OWGR', () => {
  it('never picks the top 4 top-tier (lowest owgr ranks 1-4)', () => {
    const field = makeField({ tops: 20, darks: 30 });
    const excluded = new Set(['top-1', 'top-2', 'top-3', 'top-4']);

    // Run many iterations with different RNG seeds.
    for (let seed = 1; seed <= 50; seed++) {
      const r = buildAutoLineup({
        fieldGolfers: field.golfers, topTierIds: field.topTierIds,
        takenHashes: new Set(), rng: seededRng(seed),
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        for (const id of r.golferIds) {
          expect(excluded.has(id)).toBe(false);
        }
      }
    }
  });

  it('never picks the top 4 dark-horse (lowest owgr ranks 25-28)', () => {
    const field = makeField({ tops: 20, darks: 30 });
    const excluded = new Set(['dark-1', 'dark-2', 'dark-3', 'dark-4']);

    for (let seed = 1; seed <= 50; seed++) {
      const r = buildAutoLineup({
        fieldGolfers: field.golfers, topTierIds: field.topTierIds,
        takenHashes: new Set(), rng: seededRng(seed),
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        for (const id of r.golferIds) {
          expect(excluded.has(id)).toBe(false);
        }
      }
    }
  });

  it('honors a custom excludeTopN', () => {
    const field = makeField({ tops: 20, darks: 30 });
    const r = buildAutoLineup({
      fieldGolfers: field.golfers, topTierIds: field.topTierIds,
      takenHashes: new Set(),
      excludeTopN: 8,
      rng: seededRng(1),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Slot 1+2 must be tops 9-20 (rank > 8)
      for (const id of r.topGolferIds) {
        const n = parseInt(id.replace('top-', ''));
        expect(n).toBeGreaterThan(8);
      }
      // Slot 3+4 must be darks 9-30 (i.e. owgr > 24+8 = 32)
      for (const id of r.darkGolferIds) {
        const n = parseInt(id.replace('dark-', ''));
        expect(n).toBeGreaterThan(8);
      }
    }
  });
});

describe('buildAutoLineup — uniqueness vs takenHashes', () => {
  it('never returns a foursome whose hash matches an existing pick', () => {
    const field = makeField({ tops: 20, darks: 30 });
    // Take 100 random foursomes and stamp them as taken. Then ensure
    // the next 50 generations never collide with any.
    const taken = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const r = buildAutoLineup({
        fieldGolfers: field.golfers, topTierIds: field.topTierIds,
        takenHashes: taken, rng: seededRng(i * 31 + 7),
      });
      if (r.ok) taken.add(r.hash);
    }
    expect(taken.size).toBeGreaterThan(50);

    for (let i = 0; i < 50; i++) {
      const r = buildAutoLineup({
        fieldGolfers: field.golfers, topTierIds: field.topTierIds,
        takenHashes: taken, rng: seededRng(1000 + i),
      });
      if (r.ok) {
        // Don't add to taken here — just verify each generation is
        // disjoint from the prior 100.
        expect(taken.has(r.hash)).toBe(false);
      }
    }
  });

  it('falls through to deterministic search when RNG keeps colliding', () => {
    // Tiny pool: 6 tops + 6 darks → exclude 4 each → 2x2 pool → exactly
    // 1 unique foursome possible. Stamp that one combination as taken
    // and verify we get a graceful failure.
    const field = makeField({ tops: 6, darks: 6 });
    const onlyValid: [string, string, string, string] = ['top-5', 'top-6', 'dark-5', 'dark-6'];
    const taken = new Set([computeFoursomeHash(onlyValid)]);
    const r = buildAutoLineup({
      fieldGolfers: field.golfers, topTierIds: field.topTierIds,
      takenHashes: taken, rng: seededRng(1),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no unique foursome possible/);
  });
});

describe('buildAutoLineup — tier assignment', () => {
  it('places 2 top-tier golfers in slots 1+2 and 2 dark horses in 3+4', () => {
    const field = makeField({ tops: 20, darks: 30 });
    for (let seed = 1; seed <= 20; seed++) {
      const r = buildAutoLineup({
        fieldGolfers: field.golfers, topTierIds: field.topTierIds,
        takenHashes: new Set(), rng: seededRng(seed),
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.golferIds[0]).toMatch(/^top-/);
        expect(r.golferIds[1]).toMatch(/^top-/);
        expect(r.golferIds[2]).toMatch(/^dark-/);
        expect(r.golferIds[3]).toMatch(/^dark-/);
        expect(r.topGolferIds).toEqual([r.golferIds[0], r.golferIds[1]]);
        expect(r.darkGolferIds).toEqual([r.golferIds[2], r.golferIds[3]]);
      }
    }
  });

  it('produces 4 distinct golfer IDs every time', () => {
    const field = makeField({ tops: 20, darks: 30 });
    for (let seed = 1; seed <= 20; seed++) {
      const r = buildAutoLineup({
        fieldGolfers: field.golfers, topTierIds: field.topTierIds,
        takenHashes: new Set(), rng: seededRng(seed),
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(new Set(r.golferIds).size).toBe(4);
    }
  });

  it('treats null-OWGR golfers as dark-horse (never top-tier) and ranks them last', () => {
    // Mix: 6 ranked top, 6 ranked dark, 5 null-rank golfers tagged as
    // dark horse. Exclude top 4 of each → pool: 2 top (ranks 5-6),
    // 2 dark + 5 null darks. The 5 null-rank ones SHOULD be considered
    // (their owgr_rank treats as +Infinity, so they're last in the
    // sort, NOT in the top-4 excluded).
    const field = makeField({ tops: 6, darks: 6 });
    for (let i = 1; i <= 5; i++) {
      // Null-rank golfers join the field; computeTopTierIds excludes
      // them by definition so they land in the dark pool.
      field.golfers.push({ id: `null-${i}`, name: `Null ${i}`, owgr_rank: null });
    }
    for (let seed = 1; seed <= 30; seed++) {
      const r = buildAutoLineup({
        fieldGolfers: field.golfers, topTierIds: field.topTierIds,
        takenHashes: new Set(), rng: seededRng(seed),
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        // No `dark-1` through `dark-4` (those are the excluded top 4 darks).
        for (const id of r.golferIds) {
          expect(['dark-1', 'dark-2', 'dark-3', 'dark-4'].includes(id)).toBe(false);
        }
      }
    }
  });
});

describe('AUTO_LINEUP_EXCLUDE_TOP_N constant', () => {
  it('is 4 per the 2026-06-04 spec', () => {
    expect(AUTO_LINEUP_EXCLUDE_TOP_N).toBe(4);
  });
});
