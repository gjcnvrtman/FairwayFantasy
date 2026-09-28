// ============================================================
// LEAGUE SETUP LIFECYCLE (migration 025)
//
//   legacy → pre-025 league; never locks, keeps its old admin editors.
//   setup  → new league; commissioner can change rules + schedule.
//   locked → rules, bets, penalties, window and schedule are frozen.
//
// A setup league locks when the commissioner presses "Lock league
// setup", or automatically 1 minute before any tournament on its
// schedule locks picks — rules can never change after money is at stake.
// Auto-lock runs from the sync sweep and is also checked on every
// admin request via resolveSetupStatus(), so there's no window between
// the deadline and the next sweep where rules are still editable.
// ============================================================

import { sql } from 'kysely';
import { db } from './db';

export type SetupStatus = 'legacy' | 'setup' | 'locked';

// Auto-lock moment: 1 minute before picks lock (Greg, 2026-09-28) —
// the effective pick deadline (override > computed, as in
// effectivePickDeadline()), or the tournament start if that is earlier
// or the deadline columns are empty. LEAST ignores NULLs. Rules can
// never change once picks are locked.
const deadlineExpr = sql<Date>`(LEAST(COALESCE(t.pick_deadline_override, t.pick_deadline), t.start_date) - INTERVAL '1 minute')`;

/**
 * Lock every setup-mode league (or just `leagueId`) that has a
 * scheduled tournament whose deadline has passed. Idempotent.
 * Returns the ids of leagues locked by this call.
 */
export async function autoLockSetupLeagues(leagueId?: string): Promise<string[]> {
  const rows = await db.updateTable('leagues')
    .set({ setup_status: 'locked', setup_locked_at: new Date().toISOString() })
    .where('setup_status', '=', 'setup')
    .$if(!!leagueId, qb => qb.where('id', '=', leagueId!))
    .where(eb => eb.exists(
      eb.selectFrom('league_tournaments as lt')
        .innerJoin('tournaments as t', 't.id', 'lt.tournament_id')
        .select(sql`1`.as('one'))
        .whereRef('lt.league_id', '=', 'leagues.id')
        .where(deadlineExpr, '<=', sql<Date>`NOW()`),
    ))
    .returning('id')
    .execute();
  return rows.map(r => r.id);
}

/**
 * Current status, applying auto-lock first for setup leagues. Re-reads
 * the row after the auto-lock attempt so a lock that landed after the
 * caller loaded `league` (sync sweep, concurrent request) is honored.
 */
export async function resolveSetupStatus(league: {
  id: string;
  setup_status: SetupStatus;
}): Promise<SetupStatus> {
  if (league.setup_status !== 'setup') return league.setup_status;
  await autoLockSetupLeagues(league.id);
  const row = await db.selectFrom('leagues')
    .select('setup_status')
    .where('id', '=', league.id)
    .executeTakeFirst();
  return (row?.setup_status ?? league.setup_status) as SetupStatus;
}

/**
 * Earliest upcoming deadline on this league's schedule — when a setup
 * league will auto-lock. null when nothing is scheduled.
 */
export async function nextAutoLock(leagueId: string): Promise<{
  tournamentName: string;
  at: Date;
} | null> {
  const row = await db.selectFrom('league_tournaments as lt')
    .innerJoin('tournaments as t', 't.id', 'lt.tournament_id')
    .select(['t.name', deadlineExpr.as('deadline')])
    .where('lt.league_id', '=', leagueId)
    .where(deadlineExpr, '>', sql<Date>`NOW()`)
    .orderBy(deadlineExpr)
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return { tournamentName: row.name, at: new Date(row.deadline) };
}
