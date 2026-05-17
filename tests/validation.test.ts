import { describe, it, expect } from 'vitest';
import {
  validateCreateLeague,
  deriveSlugFromName,
  LEAGUE_LIMITS,
} from '@/lib/validation';

// ─────────────────────────────────────────────────────────────
// validateCreateLeague — happy path + every validation failure
// ─────────────────────────────────────────────────────────────

describe('validateCreateLeague', () => {
  // Reusable valid baseline; each failure test mutates one field
  // so a regression in one branch can't accidentally satisfy another.
  const valid = {
    name:            'The Boys Golf Club',
    slug:            'the-boys',
    maxPlayers:      12,
    startDate:       '2026-05-14',
    endDate:         '2026-12-31',
    weeklyBetAmount: 10,
  };

  describe('happy path', () => {
    it('returns no errors for a fully valid input', () => {
      expect(validateCreateLeague(valid)).toEqual({});
    });

    it('accepts the minimum-length name', () => {
      const r = validateCreateLeague({ ...valid, name: 'a'.repeat(LEAGUE_LIMITS.NAME_MIN) });
      expect(r.name).toBeUndefined();
    });

    it('accepts the maximum-length name', () => {
      const r = validateCreateLeague({ ...valid, name: 'a'.repeat(LEAGUE_LIMITS.NAME_MAX) });
      expect(r.name).toBeUndefined();
    });

    it('accepts the minimum-length slug', () => {
      const r = validateCreateLeague({ ...valid, slug: 'a'.repeat(LEAGUE_LIMITS.SLUG_MIN) });
      expect(r.slug).toBeUndefined();
    });

    it('accepts the maximum-length slug', () => {
      const r = validateCreateLeague({ ...valid, slug: 'a'.repeat(LEAGUE_LIMITS.SLUG_MAX) });
      expect(r.slug).toBeUndefined();
    });

    it('accepts hyphens inside the slug', () => {
      const r = validateCreateLeague({ ...valid, slug: 'the-boys-2026' });
      expect(r.slug).toBeUndefined();
    });

    it('accepts the smallest valid maxPlayers', () => {
      const r = validateCreateLeague({ ...valid, maxPlayers: LEAGUE_LIMITS.MAX_PLAYERS_MIN });
      expect(r.maxPlayers).toBeUndefined();
    });

    it('accepts the largest valid maxPlayers', () => {
      const r = validateCreateLeague({ ...valid, maxPlayers: LEAGUE_LIMITS.MAX_PLAYERS_MAX });
      expect(r.maxPlayers).toBeUndefined();
    });
  });

  describe('name failures', () => {
    it('rejects empty name', () => {
      expect(validateCreateLeague({ ...valid, name: '' }).name)
        .toBeDefined();
    });

    it('rejects whitespace-only name', () => {
      expect(validateCreateLeague({ ...valid, name: '   ' }).name)
        .toBeDefined();
    });

    it('rejects name shorter than NAME_MIN', () => {
      const tooShort = 'a'.repeat(LEAGUE_LIMITS.NAME_MIN - 1);
      const e = validateCreateLeague({ ...valid, name: tooShort }).name;
      expect(e).toBeDefined();
      expect(e).toContain(`${LEAGUE_LIMITS.NAME_MIN}`);
    });

    it('rejects name longer than NAME_MAX', () => {
      const tooLong = 'a'.repeat(LEAGUE_LIMITS.NAME_MAX + 1);
      const e = validateCreateLeague({ ...valid, name: tooLong }).name;
      expect(e).toBeDefined();
      expect(e).toContain(`${LEAGUE_LIMITS.NAME_MAX}`);
    });
  });

  describe('slug failures', () => {
    it('rejects empty slug', () => {
      expect(validateCreateLeague({ ...valid, slug: '' }).slug).toBeDefined();
    });

    it('rejects slug with uppercase letters', () => {
      const e = validateCreateLeague({ ...valid, slug: 'The-Boys' }).slug;
      expect(e).toBeDefined();
      expect(e?.toLowerCase()).toContain('lowercase');
    });

    it('rejects slug with special characters (underscore)', () => {
      expect(validateCreateLeague({ ...valid, slug: 'the_boys' }).slug)
        .toBeDefined();
    });

    it('rejects slug with spaces', () => {
      expect(validateCreateLeague({ ...valid, slug: 'the boys' }).slug)
        .toBeDefined();
    });

    it('rejects slug starting with hyphen', () => {
      expect(validateCreateLeague({ ...valid, slug: '-the-boys' }).slug)
        .toBeDefined();
    });

    it('rejects slug ending with hyphen', () => {
      expect(validateCreateLeague({ ...valid, slug: 'the-boys-' }).slug)
        .toBeDefined();
    });

    it('rejects slug with consecutive hyphens', () => {
      expect(validateCreateLeague({ ...valid, slug: 'the--boys' }).slug)
        .toBeDefined();
    });

    it('rejects slug shorter than SLUG_MIN', () => {
      const tooShort = 'a'.repeat(Math.max(0, LEAGUE_LIMITS.SLUG_MIN - 1));
      expect(validateCreateLeague({ ...valid, slug: tooShort }).slug)
        .toBeDefined();
    });

    it('rejects slug longer than SLUG_MAX', () => {
      const tooLong = 'a'.repeat(LEAGUE_LIMITS.SLUG_MAX + 1);
      expect(validateCreateLeague({ ...valid, slug: tooLong }).slug)
        .toBeDefined();
    });
  });

  describe('maxPlayers failures', () => {
    it('rejects non-number maxPlayers', () => {
      // simulate what the API might receive from JSON.parse('"20"')
      const r = validateCreateLeague({ ...valid, maxPlayers: '20' as unknown as number });
      expect(r.maxPlayers).toBeDefined();
    });

    it('rejects NaN', () => {
      expect(validateCreateLeague({ ...valid, maxPlayers: NaN }).maxPlayers)
        .toBeDefined();
    });

    it('rejects non-integer', () => {
      expect(validateCreateLeague({ ...valid, maxPlayers: 12.5 }).maxPlayers)
        .toBeDefined();
    });

    it('rejects below MAX_PLAYERS_MIN', () => {
      expect(validateCreateLeague({ ...valid, maxPlayers: LEAGUE_LIMITS.MAX_PLAYERS_MIN - 1 }).maxPlayers)
        .toBeDefined();
    });

    it('rejects above MAX_PLAYERS_MAX', () => {
      expect(validateCreateLeague({ ...valid, maxPlayers: LEAGUE_LIMITS.MAX_PLAYERS_MAX + 1 }).maxPlayers)
        .toBeDefined();
    });

    it('rejects zero', () => {
      expect(validateCreateLeague({ ...valid, maxPlayers: 0 }).maxPlayers)
        .toBeDefined();
    });

    it('rejects negative', () => {
      expect(validateCreateLeague({ ...valid, maxPlayers: -5 }).maxPlayers)
        .toBeDefined();
    });
  });

  describe('startDate / endDate', () => {
    it('rejects missing startDate', () => {
      const r = validateCreateLeague({ ...valid, startDate: '' });
      expect(r.startDate).toBeDefined();
    });
    it('rejects missing endDate', () => {
      const r = validateCreateLeague({ ...valid, endDate: '' });
      expect(r.endDate).toBeDefined();
    });
    it('rejects malformed date strings', () => {
      const a = validateCreateLeague({ ...valid, startDate: '05/14/2026' });
      const b = validateCreateLeague({ ...valid, endDate: 'not-a-date' });
      expect(a.startDate).toBeDefined();
      expect(b.endDate).toBeDefined();
    });
    it('rejects endDate before startDate', () => {
      const r = validateCreateLeague({
        ...valid, startDate: '2026-12-01', endDate: '2026-01-01',
      });
      expect(r.endDate).toBeDefined();
    });
    it('accepts identical start and end dates (single-day window)', () => {
      const r = validateCreateLeague({
        ...valid, startDate: '2026-05-14', endDate: '2026-05-14',
      });
      expect(r.startDate).toBeUndefined();
      expect(r.endDate).toBeUndefined();
    });
  });

  describe('weeklyBetAmount', () => {
    it('accepts default $10', () => {
      const r = validateCreateLeague({ ...valid, weeklyBetAmount: 10 });
      expect(r.weeklyBetAmount).toBeUndefined();
    });
    it('accepts $0 (free leagues)', () => {
      const r = validateCreateLeague({ ...valid, weeklyBetAmount: 0 });
      expect(r.weeklyBetAmount).toBeUndefined();
    });
    it('accepts $5.50 (2 decimals)', () => {
      const r = validateCreateLeague({ ...valid, weeklyBetAmount: 5.5 });
      expect(r.weeklyBetAmount).toBeUndefined();
    });
    it('rejects negative bet', () => {
      const r = validateCreateLeague({ ...valid, weeklyBetAmount: -1 });
      expect(r.weeklyBetAmount).toBeDefined();
    });
    it('rejects bet over BET_MAX', () => {
      const r = validateCreateLeague({ ...valid, weeklyBetAmount: 5000 });
      expect(r.weeklyBetAmount).toBeDefined();
    });
    it('rejects bet with more than 2 decimal places', () => {
      const r = validateCreateLeague({ ...valid, weeklyBetAmount: 10.555 });
      expect(r.weeklyBetAmount).toBeDefined();
    });
    it('rejects non-numeric bet', () => {
      const r = validateCreateLeague({ ...valid, weeklyBetAmount: NaN });
      expect(r.weeklyBetAmount).toBeDefined();
    });
  });

  describe('multi-field failures', () => {
    it('returns errors on every failing field at once', () => {
      const r = validateCreateLeague({
        name: '', slug: 'BAD', maxPlayers: 100,
        startDate: '', endDate: 'bad', weeklyBetAmount: -5,
      });
      expect(r.name).toBeDefined();
      expect(r.slug).toBeDefined();
      expect(r.maxPlayers).toBeDefined();
      expect(r.startDate).toBeDefined();
      expect(r.endDate).toBeDefined();
      expect(r.weeklyBetAmount).toBeDefined();
    });
  });
});

// ─────────────────────────────────────────────────────────────
// deriveSlugFromName
// ─────────────────────────────────────────────────────────────

describe('deriveSlugFromName', () => {
  it('lowercases and hyphenates a typical name', () => {
    expect(deriveSlugFromName('The Boys Golf Club')).toBe('the-boys-golf-club');
  });

  it('collapses multiple non-alphanumeric chars into a single hyphen', () => {
    expect(deriveSlugFromName('Foo  &  Bar -- Baz')).toBe('foo-bar-baz');
  });

  it('trims leading and trailing hyphens', () => {
    expect(deriveSlugFromName('  !! Hello !!  ')).toBe('hello');
  });

  it('strips emoji and unicode', () => {
    expect(deriveSlugFromName('🏌️ The Crew 🏆')).toBe('the-crew');
  });

  it('caps output at SLUG_MAX', () => {
    const long = 'a'.repeat(200);
    expect(deriveSlugFromName(long).length).toBeLessThanOrEqual(LEAGUE_LIMITS.SLUG_MAX);
  });

  it('returns empty string for input with no alphanumerics', () => {
    expect(deriveSlugFromName('!!! ??? ###')).toBe('');
  });

  it('preserves digits', () => {
    expect(deriveSlugFromName('Boys 2026')).toBe('boys-2026');
  });
});
