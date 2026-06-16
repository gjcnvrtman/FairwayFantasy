// Tests for decideTournamentStatus — the per-sync completion gate
// extracted from syncTournament after the 2026-06-14 RBC Canadian Open
// "wrong winner" incident (status flipped to complete with R4=0 for
// every golfer due to a linescores-length heuristic misfiring during
// a rain-delayed R3/R4 overlap).

import { describe, it, expect } from 'vitest';
import { decideTournamentStatus } from '@/lib/sync';

describe('decideTournamentStatus — STATUS_FINAL drives "complete"', () => {
  it('STATUS_FINAL → complete regardless of cut state', () => {
    expect(decideTournamentStatus('STATUS_FINAL', true)).toBe('complete');
    expect(decideTournamentStatus('STATUS_FINAL', false)).toBe('complete');
  });

  it('case-insensitive substring match for "final" so X_FINAL variants survive', () => {
    // ESPN sometimes namespaces statuses (e.g. STATUS_FINAL_PEN for
    // overtime sports). Defensive substring match.
    expect(decideTournamentStatus('STATUS_FINAL', true)).toBe('complete');
    expect(decideTournamentStatus('status_final', true)).toBe('complete');
    expect(decideTournamentStatus('STATUS_FINAL_OT', true)).toBe('complete');
    expect(decideTournamentStatus('Final', true)).toBe('complete');
  });
});

describe('decideTournamentStatus — in-progress states fall through to cut logic', () => {
  it('STATUS_IN_PROGRESS + cutHasBeenMade=false → active', () => {
    expect(decideTournamentStatus('STATUS_IN_PROGRESS', false)).toBe('active');
  });

  it('STATUS_IN_PROGRESS + cutHasBeenMade=true → cut_made', () => {
    expect(decideTournamentStatus('STATUS_IN_PROGRESS', true)).toBe('cut_made');
  });

  it('STATUS_PLAY_COMPLETE (R2 end-of-day, cut math determined) + cutHasBeenMade=true → cut_made', () => {
    expect(decideTournamentStatus('STATUS_PLAY_COMPLETE', true)).toBe('cut_made');
  });

  it('STATUS_SCHEDULED + no cut → active', () => {
    expect(decideTournamentStatus('STATUS_SCHEDULED', false)).toBe('active');
  });

  it('unknown ESPN status falls through to cut-driven branch', () => {
    expect(decideTournamentStatus('SOMETHING_UNKNOWN', true)).toBe('cut_made');
    expect(decideTournamentStatus('SOMETHING_UNKNOWN', false)).toBe('active');
  });
});

describe('decideTournamentStatus — regression for 2026-06-14 RBC Canadian Open', () => {
  it('linescores-length signal NO LONGER promotes to complete (the old bug path)', () => {
    // Old code path: status = STATUS_IN_PROGRESS + every cut survivor
    // had linescores.length === 4 + end_date had passed → flipped to
    // complete with R4=0 for all golfers. The new helper ignores
    // linescore/end_date inputs entirely — only ESPN's status string
    // matters here. Cut state stays in cut_made.
    expect(decideTournamentStatus('STATUS_IN_PROGRESS', true)).toBe('cut_made');
  });

  it('does NOT flip to complete just because the status contains "complete" word', () => {
    // Defensive: we anchor on "final", not "complete". STATUS_PLAY_COMPLETE
    // is the post-R2-pre-R3 cut window, NOT tournament-over.
    expect(decideTournamentStatus('STATUS_PLAY_COMPLETE', true)).toBe('cut_made');
    expect(decideTournamentStatus('STATUS_PLAY_COMPLETE', false)).toBe('active');
  });
});
