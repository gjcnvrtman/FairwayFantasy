// ============================================================
// AUTH DECISION LOGIC — pure, dependency-free.
//
// These functions encode "given these inputs, what status code
// should we return?" without touching the DB, NextAuth, or any
// other I/O. That keeps the unit tests fast and lets us cover
// every branch without spinning up infrastructure.
//
// The non-pure wrappers (`requireCommissioner`, etc.) live in
// `auth-league.ts` and call these helpers internally.
// ============================================================

export type Role = 'commissioner' | 'co_commissioner' | 'member';

export type AuthDecision =
  | { code: 200 }
  | { code: 400; reason: 'no-identifier' }
  | { code: 401; reason: 'unauthenticated' }
  | { code: 403; reason: 'not-commissioner' }
  | { code: 403; reason: 'not-commissioner-or-above' }
  | { code: 404; reason: 'no-league-or-not-member' };

export function decideCommissionerAuth(input: {
  hasIdentifier: boolean;
  user:          { id: string } | null;
  league:        { id: string } | null;
  membership:    { role: Role } | null;
}): AuthDecision {
  if (!input.hasIdentifier)        return { code: 400, reason: 'no-identifier' };
  if (!input.user)                 return { code: 401, reason: 'unauthenticated' };
  if (!input.league)               return { code: 404, reason: 'no-league-or-not-member' };
  if (!input.membership)           return { code: 404, reason: 'no-league-or-not-member' };
  if (input.membership.role !== 'commissioner')
                                   return { code: 403, reason: 'not-commissioner' };
  return { code: 200 };
}

/**
 * Used by operational actions (sync scores, send reminders, set pick
 * deadlines, regen invite code, remove members) where co_commissioners
 * are allowed to act as deputies. Structural actions (delete league,
 * edit settings, change roles) keep using ``decideCommissionerAuth``.
 */
export function decideCoCommissionerOrAboveAuth(input: {
  hasIdentifier: boolean;
  user:          { id: string } | null;
  league:        { id: string } | null;
  membership:    { role: Role } | null;
}): AuthDecision {
  if (!input.hasIdentifier)        return { code: 400, reason: 'no-identifier' };
  if (!input.user)                 return { code: 401, reason: 'unauthenticated' };
  if (!input.league)               return { code: 404, reason: 'no-league-or-not-member' };
  if (!input.membership)           return { code: 404, reason: 'no-league-or-not-member' };
  if (input.membership.role !== 'commissioner' && input.membership.role !== 'co_commissioner')
                                   return { code: 403, reason: 'not-commissioner-or-above' };
  return { code: 200 };
}

export function decideMemberAuth(input: {
  hasIdentifier: boolean;
  user:          { id: string } | null;
  league:        { id: string } | null;
  membership:    { role: Role } | null;
}): AuthDecision {
  if (!input.hasIdentifier)        return { code: 400, reason: 'no-identifier' };
  if (!input.user)                 return { code: 401, reason: 'unauthenticated' };
  if (!input.league)               return { code: 404, reason: 'no-league-or-not-member' };
  if (!input.membership)           return { code: 404, reason: 'no-league-or-not-member' };
  return { code: 200 };
}

/**
 * Returns true if removing this user from this league would leave
 * it with zero ``commissioner`` rows — i.e. the action MUST be
 * blocked. Counts ONLY ``commissioner``, not ``co_commissioner``:
 * a league with 0 commissioners and N co_commissioners is
 * functionally orphaned because co's can't promote new ones or
 * delete the league.
 *
 * Pure: takes the current member list. Caller fetches it.
 */
export function wouldOrphanLeague(input: {
  members:    Array<{ user_id: string; role: Role }>;
  removeUserId: string;
}): boolean {
  const remaining = input.members.filter(m => m.user_id !== input.removeUserId);
  return !remaining.some(m => m.role === 'commissioner');
}
