// ============================================================
// LEAGUE DASHBOARD — derived state helpers
// Pure functions used by /league/[slug]/page.tsx
// ============================================================
//
// These exist so the page itself stays mostly markup and the
// "what should the user see right now?" logic is unit-testable
// without spinning up a full RSC harness.
//
// Naming: every status flag describes *what to show*, not *how
// to render it*. The page picks the styling.

export type LockStatus =
  | { state: 'open';   deadline: Date }
  | { state: 'open-no-deadline' }
  | { state: 'locked' }
  | { state: 'no-tournament' };

/**
 * Derive the lock status for the league's current tournament.
 *
 * Rule: picks are open iff the tournament status is `'upcoming'`.
 * Once status flips to `'active'`/`'cut_made'`/`'complete'` the
 * pick window has closed.
 *
 * The dashboard ALSO wants to know whether to show a deadline label
 * (we don't always have one) so we surface that here rather than
 * threading the boolean check at every callsite.
 */
export function deriveLockStatus(tournament: {
  status: string;
  pick_deadline: string | null;
} | null | undefined): LockStatus {
  if (!tournament) return { state: 'no-tournament' };
  if (tournament.status !== 'upcoming') return { state: 'locked' };
  if (!tournament.pick_deadline) return { state: 'open-no-deadline' };
  return { state: 'open', deadline: new Date(tournament.pick_deadline) };
}

/**
 * Decide whether other players' picks are visible to this user.
 *
 * Privacy rule: only show foursomes once the tournament has started
 * (status flips off 'upcoming'). Before that, surfacing a peer's
 * picks would let the user copy their lineup at the last second —
 * the very thing the no-copycats rule guards against, but that rule
 * only blocks insertion of an *identical* set; revealing 3-of-4 is
 * still a privacy leak.
 *
 * The current user can ALWAYS see their own picks regardless.
 */
export function shouldRevealOtherPicks(lock: LockStatus): boolean {
  return lock.state === 'locked';
}

export type EmptyStateReason =
  | null                          // not empty — show real content
  | 'no-leagues'                  // user has zero leagues
  | 'solo-commissioner'           // league has only the commissioner so far
  | 'no-tournament-no-upcoming'   // commissioner needs to populate schedule
  | 'no-tournament-but-upcoming'; // tournament scheduled but not started

/**
 * Pick the right "empty" hint for the league dashboard. The page
 * decides what copy/CTA to show for each.
 *
 * Argument shape mirrors what the RSC page already has in scope.
 */
export function deriveLeagueEmptyState(args: {
  memberCount:        number;
  hasActiveTournament: boolean;
  hasUpcoming:         boolean;
}): EmptyStateReason {
  const { memberCount, hasActiveTournament, hasUpcoming } = args;

  // The most visible problem first.
  if (memberCount <= 1)            return 'solo-commissioner';
  if (hasActiveTournament)         return null;
  if (!hasUpcoming)                return 'no-tournament-no-upcoming';
  return 'no-tournament-but-upcoming';
}

/**
 * What CTA, if any, should we surface in the hero?
 *
 * - 'submit-picks'  → user has no pick yet AND picks are open
 * - 'edit-picks'    → user has a pick AND picks are still open
 * - 'view-picks'    → picks are locked AND tournament is in play
 * - 'submit-next'   → no active tournament but next is upcoming
 * - 'none'          → no actionable surface (nothing to pick yet)
 */
export type HeroCTA = 'submit-picks' | 'edit-picks' | 'view-picks' | 'submit-next' | 'none';

export function deriveHeroCTA(args: {
  hasActiveTournament: boolean;
  hasUpcoming:         boolean;
  userHasPick:         boolean;
  lock:                LockStatus;
}): HeroCTA {
  const { hasActiveTournament, hasUpcoming, userHasPick, lock } = args;

  if (hasActiveTournament) {
    if (lock.state === 'locked') return 'view-picks';
    return userHasPick ? 'edit-picks' : 'submit-picks';
  }
  if (hasUpcoming) return 'submit-next';
  return 'none';
}
