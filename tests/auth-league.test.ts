import { describe, it, expect } from 'vitest';
// Import directly from the pure module — importing from
// `@/lib/auth-league` would transitively pull NextAuth and `pg` into
// the Vitest runner, which fails because Vitest doesn't have Next's
// module resolution shims.
import {
  decideCommissionerAuth,
  decideMemberAuth,
  wouldOrphanLeague,
  type Role,
} from '@/lib/auth-decisions';

// ─────────────────────────────────────────────────────────────
// decideCommissionerAuth — every branch must return the right code
// ─────────────────────────────────────────────────────────────

describe('decideCommissionerAuth', () => {
  const okMembership = { role: 'commissioner' as Role };
  const userU       = { id: 'u1' };
  const leagueL     = { id: 'lg1' };

  it('returns 200 for a commissioner of an existing league', () => {
    expect(decideCommissionerAuth({
      hasIdentifier: true, user: userU, league: leagueL, membership: okMembership,
    })).toEqual({ code: 200 });
  });

  it('returns 400 when no identifier supplied', () => {
    // No slug AND no leagueId.
    expect(decideCommissionerAuth({
      hasIdentifier: false, user: userU, league: leagueL, membership: okMembership,
    })).toEqual({ code: 400, reason: 'no-identifier' });
  });

  it('returns 401 when there is no session', () => {
    expect(decideCommissionerAuth({
      hasIdentifier: true, user: null, league: leagueL, membership: okMembership,
    })).toEqual({ code: 401, reason: 'unauthenticated' });
  });

  it('returns 404 when the league does not exist', () => {
    expect(decideCommissionerAuth({
      hasIdentifier: true, user: userU, league: null, membership: null,
    })).toEqual({ code: 404, reason: 'no-league-or-not-member' });
  });

  it('returns 404 when the user is not a member of the league', () => {
    // Privacy rule: don't leak league existence to non-members. We
    // collapse "league doesn't exist" with "you're not in it" so an
    // attacker can't probe for league IDs.
    expect(decideCommissionerAuth({
      hasIdentifier: true, user: userU, league: leagueL, membership: null,
    })).toEqual({ code: 404, reason: 'no-league-or-not-member' });
  });

  it('returns 403 when the user is a member but not a commissioner', () => {
    expect(decideCommissionerAuth({
      hasIdentifier: true, user: userU, league: leagueL,
      membership: { role: 'member' },
    })).toEqual({ code: 403, reason: 'not-commissioner' });
  });

  it('checks identifier presence BEFORE auth (so missing-id 400s for everyone)', () => {
    // A non-authenticated request with no identifier still gets 400.
    expect(decideCommissionerAuth({
      hasIdentifier: false, user: null, league: null, membership: null,
    })).toEqual({ code: 400, reason: 'no-identifier' });
  });
});

// ─────────────────────────────────────────────────────────────
// decideMemberAuth — same as commissioner but accepts members
// ─────────────────────────────────────────────────────────────

describe('decideMemberAuth', () => {
  const userU   = { id: 'u1' };
  const leagueL = { id: 'lg1' };

  it('accepts members', () => {
    expect(decideMemberAuth({
      hasIdentifier: true, user: userU, league: leagueL,
      membership: { role: 'member' },
    })).toEqual({ code: 200 });
  });

  it('accepts commissioners', () => {
    expect(decideMemberAuth({
      hasIdentifier: true, user: userU, league: leagueL,
      membership: { role: 'commissioner' },
    })).toEqual({ code: 200 });
  });

  it('still 404s non-members', () => {
    expect(decideMemberAuth({
      hasIdentifier: true, user: userU, league: leagueL, membership: null,
    })).toEqual({ code: 404, reason: 'no-league-or-not-member' });
  });

  it('still 401s unauthenticated', () => {
    expect(decideMemberAuth({
      hasIdentifier: true, user: null, league: leagueL,
      membership: { role: 'member' },
    })).toEqual({ code: 401, reason: 'unauthenticated' });
  });

  it('still 400s missing identifier', () => {
    expect(decideMemberAuth({
      hasIdentifier: false, user: userU, league: leagueL,
      membership: { role: 'member' },
    })).toEqual({ code: 400, reason: 'no-identifier' });
  });
});

// ─────────────────────────────────────────────────────────────
// wouldOrphanLeague — last-commissioner guard
// ─────────────────────────────────────────────────────────────

describe('wouldOrphanLeague', () => {
  it('blocks removing the only commissioner', () => {
    expect(wouldOrphanLeague({
      members: [
        { user_id: 'comm', role: 'commissioner' },
        { user_id: 'm1',   role: 'member' },
        { user_id: 'm2',   role: 'member' },
      ],
      removeUserId: 'comm',
    })).toBe(true);
  });

  it('blocks removing the only commissioner from a 1-member league', () => {
    expect(wouldOrphanLeague({
      members: [{ user_id: 'comm', role: 'commissioner' }],
      removeUserId: 'comm',
    })).toBe(true);
  });

  it('allows removing one of two commissioners', () => {
    // Future-proof: today the schema only allows one commissioner,
    // but the guard should still permit removal if there's another.
    expect(wouldOrphanLeague({
      members: [
        { user_id: 'comm1', role: 'commissioner' },
        { user_id: 'comm2', role: 'commissioner' },
        { user_id: 'm1',    role: 'member' },
      ],
      removeUserId: 'comm1',
    })).toBe(false);
  });

  it('allows removing a regular member', () => {
    expect(wouldOrphanLeague({
      members: [
        { user_id: 'comm', role: 'commissioner' },
        { user_id: 'm1',   role: 'member' },
      ],
      removeUserId: 'm1',
    })).toBe(false);
  });

  it('allows removing a member that is not in the list (no-op semantically)', () => {
    // Defensive — caller passed a stale userId. We don't claim
    // orphaning since the league still has its commissioner.
    expect(wouldOrphanLeague({
      members: [
        { user_id: 'comm', role: 'commissioner' },
      ],
      removeUserId: 'm-doesnt-exist',
    })).toBe(false);
  });

  it('blocks removing the only commissioner even when other members exist', () => {
    expect(wouldOrphanLeague({
      members: [
        { user_id: 'comm', role: 'commissioner' },
        { user_id: 'm1',   role: 'member' },
        { user_id: 'm2',   role: 'member' },
        { user_id: 'm3',   role: 'member' },
      ],
      removeUserId: 'comm',
    })).toBe(true);
  });
});
