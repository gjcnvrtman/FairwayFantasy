// ============================================================
// REMINDER JOB — DB I/O around the pure planner in `@/lib/reminders`.
//
// Called by /api/admin/reminders:
//   - fairway-reminders.timer, every 15 min (Bearer CRON_SECRET)
//   - a commissioner session (manual trigger)
//
// Sends directly via sendEmail(), the same path as the field-set,
// scorecard and recap emails. (Until 2026-09-28 this went through a
// notifier placeholder that only console.logged, and nothing ever ran
// the job — no reminder was ever sent.)
//
// Never-twice guarantee: before sending, the job CLAIMS the
// reminder_log row, which is UNIQUE (user_id, tournament_id, channel).
// Only the run that inserts the row (or flips a 'failed' row back)
// sends. A crash between claim and send loses that one reminder rather
// than risking a duplicate.
// ============================================================

import { db } from './db';
import { sendEmail, pickReminderEmail } from './email';
import { effectivePickDeadline } from './pick-deadline';
import {
  planEmailReminders, MAX_HOURS_BEFORE,
  type ReminderPreferences, type EmailReminderTask,
} from './reminders';

export interface ReminderJobSummary {
  ok:                 boolean;
  tournamentsScanned: number;
  sent:               number;
  skipped:            number;
  failed:             number;
  results: Array<{
    user_id:       string;
    tournament_id: string;
    status:        'sent' | 'skipped' | 'failed';
    error?:        string;
  }>;
  error?: string;
}

type SendFn = typeof sendEmail;

/**
 * Run one reminder cycle. `now` and `send` are injectable for tests.
 */
export async function runReminderJob(
  args: { now?: Date; send?: SendFn } = {},
): Promise<ReminderJobSummary> {
  const now  = args.now ?? new Date();
  const send = args.send ?? sendEmail;
  const summary: ReminderJobSummary = {
    ok: true, tournamentsScanned: 0, sent: 0, skipped: 0, failed: 0, results: [],
  };

  try {
    // Upcoming, visible, field published, and picks lock within the
    // longest possible reminder window.
    const rows = await db.selectFrom('tournaments')
      .select(['id', 'name', 'status', 'pick_deadline', 'pick_deadline_override', 'field_published_at'])
      .where('status', '=', 'upcoming')
      .where('hidden', '=', false)
      .where('field_published_at', 'is not', null)
      .execute();
    const tournaments = rows
      .map(t => ({ ...t, deadline: effectivePickDeadline(t) }))
      .filter(t => t.deadline
        && t.deadline.getTime() > now.getTime()
        && t.deadline.getTime() - MAX_HOURS_BEFORE * 3600_000 <= now.getTime());

    for (const t of tournaments) {
      summary.tournamentsScanned++;

      // Only leagues with this tournament on their schedule (migration 022).
      const leagues = await db.selectFrom('leagues')
        .innerJoin('league_tournaments', 'league_tournaments.league_id', 'leagues.id')
        .select(['leagues.id', 'leagues.name', 'leagues.slug'])
        .where('league_tournaments.tournament_id', '=', t.id)
        .execute();
      if (leagues.length === 0) continue;
      const leagueIds = leagues.map(l => l.id);

      const [members, picks, log] = await Promise.all([
        db.selectFrom('league_members')
          .innerJoin('profiles', 'profiles.id', 'league_members.user_id')
          .leftJoin('reminder_preferences', 'reminder_preferences.user_id', 'league_members.user_id')
          .select([
            'league_members.user_id', 'league_members.league_id',
            'profiles.email', 'profiles.display_name',
            'reminder_preferences.email_enabled', 'reminder_preferences.sms_enabled',
            'reminder_preferences.push_enabled', 'reminder_preferences.hours_before',
            'reminder_preferences.email_addr', 'reminder_preferences.phone_e164',
            'reminder_preferences.push_token',
          ])
          .where('league_members.league_id', 'in', leagueIds)
          .execute(),
        db.selectFrom('picks')
          .select(['user_id', 'league_id'])
          .where('tournament_id', '=', t.id)
          .where('league_id', 'in', leagueIds)
          .execute(),
        db.selectFrom('reminder_log')
          .select(['user_id', 'status'])
          .where('tournament_id', '=', t.id)
          .where('channel', '=', 'email')
          .execute(),
      ]);

      const prefsByUser = new Map<string, ReminderPreferences>();
      const profileByUser = new Map<string, { email: string | null; display_name: string | null }>();
      for (const m of members) {
        profileByUser.set(m.user_id, { email: m.email, display_name: m.display_name });
        // LEFT JOIN miss → no prefs row → no reminders (account page shows "off").
        if (m.email_enabled === null) continue;
        prefsByUser.set(m.user_id, {
          user_id:       m.user_id,
          email_enabled: !!m.email_enabled,
          sms_enabled:   !!m.sms_enabled,
          push_enabled:  !!m.push_enabled,
          hours_before:  Number(m.hours_before ?? 24),
          email_addr:    m.email_addr ?? null,
          phone_e164:    m.phone_e164 ?? null,
          push_token:    m.push_token ?? null,
        });
      }

      const tasks = planEmailReminders({
        tournament: {
          id: t.id, status: t.status, fieldPublished: t.field_published_at !== null, deadline: t.deadline,
        },
        leagues,
        members: members.map(m => ({ user_id: m.user_id, league_id: m.league_id })),
        pickedKeys: new Set(picks.map(p => `${p.user_id}:${p.league_id}`)),
        prefsByUser,
        profileByUser,
        // 'failed' rows are retried; anything else is done.
        alreadyHandled: new Set(log.filter(r => r.status !== 'failed').map(r => r.user_id)),
        now,
      });

      for (const task of tasks) {
        const r = await deliver(task, t.id, t.name, t.deadline!, now, send);
        if (!r) continue;                      // another run claimed it
        summary[r.status]++;
        summary.results.push({ user_id: task.user_id, tournament_id: t.id, ...r });
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[reminders] scanned=${summary.tournamentsScanned} sent=${summary.sent} skipped=${summary.skipped} failed=${summary.failed}`);
    return summary;
  } catch (err) {
    console.error('[reminders] job error:', err);
    summary.ok = false;
    summary.error = err instanceof Error ? err.message : String(err);
    return summary;
  }
}

async function deliver(
  task: EmailReminderTask, tournamentId: string, tournamentName: string,
  deadline: Date, now: Date, send: SendFn,
): Promise<{ status: 'sent' | 'skipped' | 'failed'; error?: string } | null> {
  const leagueId = task.leagues[0].id;   // reminder_log.league_id is NOT NULL; first league listed

  // Claim: insert, or take back a previously failed row. No row
  // returned → already sent/skipped by another run → do nothing.
  const claimed = await db.insertInto('reminder_log')
    .values({
      user_id: task.user_id, league_id: leagueId, tournament_id: tournamentId,
      channel: 'email', status: 'sent', error_message: null, sent_at: now.toISOString(),
    })
    .onConflict(oc => oc
      .columns(['user_id', 'tournament_id', 'channel'])
      .doUpdateSet({ status: 'sent', error_message: null, sent_at: now.toISOString(), league_id: leagueId })
      .where('reminder_log.status', '=', 'failed'))
    .returning('id')
    .executeTakeFirst();
  if (!claimed) return null;

  const mark = async (status: 'skipped' | 'failed', error: string) => {
    await db.updateTable('reminder_log')
      .set({ status, error_message: error })
      .where('id', '=', claimed.id)
      .execute();
    return { status, error };
  };

  if (!task.destination) return mark('skipped', 'No email address on file.');

  const { subject, text, html } = pickReminderEmail({
    recipientName: task.displayName?.trim() || 'Player',
    tournamentName,
    pickDeadline: deadline,
    leagues: task.leagues,
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? '',
  });
  try {
    const ok = await send({ to: task.destination, subject, text, html });
    if (!ok) return mark('failed', 'sendEmail returned false (SMTP not configured or send error — see [email] log).');
    // eslint-disable-next-line no-console
    console.log(`[reminders] ${tournamentName} → ${task.destination} (${task.leagues.map(l => l.name).join(', ')}) sent`);
    return { status: 'sent' };
  } catch (err) {
    return mark('failed', err instanceof Error ? err.message : String(err));
  }
}
