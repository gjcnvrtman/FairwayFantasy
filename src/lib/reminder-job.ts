// ============================================================
// REMINDER JOB — DB I/O wrapper around the pure logic in
// `@/lib/reminders` and `@/lib/notifier`.
//
// Called by:
//   - /api/admin/reminders POST (commissioner manual trigger)
//   - cron systemd timer (Bearer CRON_SECRET)
// ============================================================

import { supabaseAdmin } from './supabase';
import {
  findUsersDueForReminder,
  buildPicksByUserLeague,
  buildAlreadySentSet,
  type ReminderPreferences,
  type MemberRow,
  type PickRow,
  type TournamentRow,
} from './reminders';
import {
  dispatchReminder,
  defaultReminderMessage,
  type NotifyResult,
} from './notifier';

export interface ReminderJobSummary {
  ok:               boolean;
  tournamentsScanned: number;
  tasksFound:       number;
  results:          Array<{
    user_id:       string;
    tournament_id: string;
    channel:       string;
    status:        string;
    error?:        string;
  }>;
  error?:           string;
  /** True when no real-send mode is active — informational. */
  dryRun:           boolean;
}

/**
 * Run one reminder cycle:
 *   1. Find every upcoming tournament with a pick_deadline
 *   2. For each: collect prefs + members + picks + already-sent log
 *   3. Use findUsersDueForReminder() to compute tasks
 *   4. dispatchReminder() each, log to reminder_log
 *
 * `now` defaults to the current time but is injectable so future
 * tests / admin "preview" mode can simulate windowed runs.
 */
export async function runReminderJob(args: { now?: Date } = {}): Promise<ReminderJobSummary> {
  const now = args.now ?? new Date();
  const dryRun = process.env.REMINDERS_LIVE !== 'true';
  const summary: ReminderJobSummary = {
    ok: true,
    tournamentsScanned: 0,
    tasksFound: 0,
    results: [],
    dryRun,
  };

  try {
    // ── Find candidate tournaments ──
    const { data: tournaments } = await supabaseAdmin
      .from('tournaments')
      .select('id, name, status, pick_deadline')
      .eq('status', 'upcoming')
      .not('pick_deadline', 'is', null);

    if (!tournaments?.length) return summary;

    // ── Pre-fetch global state once (faster than per-tournament) ──
    // All league members across all leagues. Tournaments are global,
    // so any league member could be eligible.
    const { data: members } = await supabaseAdmin
      .from('league_members')
      .select('user_id, league_id');

    // Reminder prefs for all users that have a row.
    const { data: prefsRows } = await supabaseAdmin
      .from('reminder_preferences')
      .select('*');

    // Profile email fallbacks.
    const userIds = Array.from(new Set((members ?? []).map(m => m.user_id)));
    const { data: profiles } = userIds.length
      ? await supabaseAdmin
          .from('profiles')
          .select('id, email')
          .in('id', userIds)
      : { data: [] as Array<{ id: string; email: string | null }> };

    const prefsByUser = new Map<string, ReminderPreferences>();
    for (const r of (prefsRows ?? []) as ReminderPreferences[]) {
      prefsByUser.set(r.user_id, r);
    }
    const profileEmailByUser = new Map<string, string | null>();
    for (const p of (profiles ?? [])) {
      profileEmailByUser.set(p.id, p.email);
    }

    for (const t of tournaments as TournamentRow[]) {
      summary.tournamentsScanned++;

      // Picks for this tournament (across all leagues).
      const { data: picks } = await supabaseAdmin
        .from('picks')
        .select('league_id, tournament_id, user_id')
        .eq('tournament_id', t.id);

      // Already-logged reminders for this tournament.
      const { data: log } = await supabaseAdmin
        .from('reminder_log')
        .select('user_id, tournament_id, channel')
        .eq('tournament_id', t.id);

      const picksByUserLeague = buildPicksByUserLeague((picks ?? []) as PickRow[]);
      const alreadySent       = buildAlreadySentSet(log ?? []);

      const tasks = findUsersDueForReminder({
        tournament:        t,
        members:           (members ?? []) as MemberRow[],
        picksByUserLeague,
        prefsByUser,
        profileEmailByUser,
        alreadySent,
        now,
      });

      summary.tasksFound += tasks.length;
      if (tasks.length === 0) continue;

      const pickDeadline = new Date(t.pick_deadline!);
      const tournamentName = (t as any).name ?? 'next tournament';

      for (const task of tasks) {
        const result = await dispatchReminder(task, t2 =>
          defaultReminderMessage({
            task: t2,
            tournamentName,
            pickDeadline,
            pickUrl: `${process.env.NEXT_PUBLIC_SITE_URL ?? ''}/dashboard`,
          })
        );

        // Persist the attempt — both for audit AND idempotency.
        await persistResult(result);

        summary.results.push({
          user_id:       task.user_id,
          tournament_id: task.tournament_id,
          channel:       task.channel,
          status:        result.status,
          error:         result.error,
        });
      }
    }

    return summary;
  } catch (err) {
    console.error('Reminder job error:', err);
    summary.ok = false;
    summary.error = err instanceof Error ? err.message : String(err);
    return summary;
  }
}

async function persistResult(result: NotifyResult): Promise<void> {
  await supabaseAdmin.from('reminder_log').insert({
    user_id:       result.task.user_id,
    league_id:     result.task.league_id,
    tournament_id: result.task.tournament_id,
    channel:       result.status === 'console'
      ? 'console'
      : result.task.channel,
    status:        result.status,
    error_message: result.error ?? null,
    sent_at:       new Date().toISOString(),
  });
}
