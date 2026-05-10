import { describe, it, expect } from 'vitest';
import {
  deriveLockStatus,
  shouldRevealOtherPicks,
  deriveLeagueEmptyState,
  deriveHeroCTA,
} from '@/lib/league-dashboard';

// ─────────────────────────────────────────────────────────────
// deriveLockStatus
// ─────────────────────────────────────────────────────────────

describe('deriveLockStatus', () => {
  it('returns no-tournament when input is null', () => {
    expect(deriveLockStatus(null).state).toBe('no-tournament');
  });

  it('returns no-tournament when input is undefined', () => {
    expect(deriveLockStatus(undefined).state).toBe('no-tournament');
  });

  it('returns locked for active tournaments', () => {
    expect(deriveLockStatus({ status: 'active', pick_deadline: null }).state).toBe('locked');
  });

  it('returns locked for cut_made tournaments', () => {
    expect(deriveLockStatus({ status: 'cut_made', pick_deadline: null }).state).toBe('locked');
  });

  it('returns locked for complete tournaments', () => {
    expect(deriveLockStatus({ status: 'complete', pick_deadline: null }).state).toBe('locked');
  });

  it('returns open with deadline for upcoming + deadline', () => {
    const lock = deriveLockStatus({
      status: 'upcoming',
      pick_deadline: '2026-04-10T11:00:00Z',
    });
    expect(lock.state).toBe('open');
    if (lock.state === 'open') {
      expect(lock.deadline).toEqual(new Date('2026-04-10T11:00:00Z'));
    }
  });

  it('returns open-no-deadline for upcoming with null deadline', () => {
    const lock = deriveLockStatus({ status: 'upcoming', pick_deadline: null });
    expect(lock.state).toBe('open-no-deadline');
  });
});

// ─────────────────────────────────────────────────────────────
// shouldRevealOtherPicks (privacy gate)
// ─────────────────────────────────────────────────────────────

describe('shouldRevealOtherPicks', () => {
  it('hides picks when state is open', () => {
    expect(shouldRevealOtherPicks({ state: 'open', deadline: new Date() })).toBe(false);
  });

  it('hides picks when state is open-no-deadline', () => {
    expect(shouldRevealOtherPicks({ state: 'open-no-deadline' })).toBe(false);
  });

  it('hides picks when there is no tournament', () => {
    expect(shouldRevealOtherPicks({ state: 'no-tournament' })).toBe(false);
  });

  it('reveals picks once locked', () => {
    expect(shouldRevealOtherPicks({ state: 'locked' })).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// deriveLeagueEmptyState
// ─────────────────────────────────────────────────────────────

describe('deriveLeagueEmptyState', () => {
  it('returns solo-commissioner when only one member exists (highest priority)', () => {
    expect(deriveLeagueEmptyState({
      memberCount: 1,
      hasActiveTournament: true,   // even with active tournament, the
      hasUpcoming: true,            // 1-member case still wins
    })).toBe('solo-commissioner');
  });

  it('returns solo-commissioner for 0-member edge case', () => {
    expect(deriveLeagueEmptyState({
      memberCount: 0,
      hasActiveTournament: false,
      hasUpcoming: false,
    })).toBe('solo-commissioner');
  });

  it('returns null (real content) when active tournament + multiple players', () => {
    expect(deriveLeagueEmptyState({
      memberCount: 4,
      hasActiveTournament: true,
      hasUpcoming: true,
    })).toBeNull();
  });

  it('returns no-tournament-no-upcoming when nothing is scheduled', () => {
    expect(deriveLeagueEmptyState({
      memberCount: 4,
      hasActiveTournament: false,
      hasUpcoming: false,
    })).toBe('no-tournament-no-upcoming');
  });

  it('returns no-tournament-but-upcoming when next event is queued', () => {
    expect(deriveLeagueEmptyState({
      memberCount: 4,
      hasActiveTournament: false,
      hasUpcoming: true,
    })).toBe('no-tournament-but-upcoming');
  });
});

// ─────────────────────────────────────────────────────────────
// deriveHeroCTA
// ─────────────────────────────────────────────────────────────

describe('deriveHeroCTA', () => {
  const openLock     = { state: 'open', deadline: new Date() } as const;
  const noDeadlineLk = { state: 'open-no-deadline' } as const;
  const lockedLk     = { state: 'locked' } as const;
  const noTournLk    = { state: 'no-tournament' } as const;

  it('shows submit-picks when active tournament + open + no pick yet', () => {
    expect(deriveHeroCTA({
      hasActiveTournament: true, hasUpcoming: false,
      userHasPick: false, lock: openLock,
    })).toBe('submit-picks');
  });

  it('shows edit-picks when active + open + already picked', () => {
    expect(deriveHeroCTA({
      hasActiveTournament: true, hasUpcoming: false,
      userHasPick: true, lock: openLock,
    })).toBe('edit-picks');
  });

  it('shows edit-picks for open-no-deadline + already picked', () => {
    // open-no-deadline is still open as far as the CTA is concerned
    expect(deriveHeroCTA({
      hasActiveTournament: true, hasUpcoming: false,
      userHasPick: true, lock: noDeadlineLk,
    })).toBe('edit-picks');
  });

  it('shows view-picks once tournament is locked', () => {
    expect(deriveHeroCTA({
      hasActiveTournament: true, hasUpcoming: false,
      userHasPick: true, lock: lockedLk,
    })).toBe('view-picks');
  });

  it('shows view-picks even if user never submitted (post-lock)', () => {
    // Defensive — they missed the deadline, but the page should still
    // give them a way to look at their (empty) pick page.
    expect(deriveHeroCTA({
      hasActiveTournament: true, hasUpcoming: false,
      userHasPick: false, lock: lockedLk,
    })).toBe('view-picks');
  });

  it('shows submit-next when no active but upcoming exists', () => {
    expect(deriveHeroCTA({
      hasActiveTournament: false, hasUpcoming: true,
      userHasPick: false, lock: noTournLk,
    })).toBe('submit-next');
  });

  it('shows none when nothing is happening', () => {
    expect(deriveHeroCTA({
      hasActiveTournament: false, hasUpcoming: false,
      userHasPick: false, lock: noTournLk,
    })).toBe('none');
  });
});
