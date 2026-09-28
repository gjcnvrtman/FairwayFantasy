// ============================================================
// PICK REMINDERS — eligibility logic
// (Pure functions — no I/O. `runReminderJob()` in
//  `src/lib/reminder-job.ts` fetches state, calls planEmailReminders,
//  then sends + logs.)
// ============================================================
//
// "Who needs a pick reminder right now" is the part most likely to
// break silently — sending the same reminder twice, or never sending
// one at all. Keeping it pure + tested guards against that.
//
// Flow:
//   1. fairway-reminders.timer (every 15 min) calls
//      /api/admin/reminders with the cron secret → runReminderJob().
//   2. The job collects state and calls planEmailReminders() (here).
//   3. For each task it claims a reminder_log row (unique per user +
//      tournament + channel), then sends the email. The claim is what
//      makes a second send impossible.
//
// Email is the only delivered channel. The account page only offers
// email; sms/push columns exist in reminder_preferences but nothing
// delivers them, so they are ignored here.

export type Channel = 'email' | 'sms' | 'push';

export interface ReminderPreferences {
  user_id:       string;
  email_enabled: boolean;
  sms_enabled:   boolean;
  push_enabled:  boolean;
  hours_before:  number;             // 1..168
  email_addr:    string | null;
  phone_e164:    string | null;
  push_token:    string | null;
}

export interface MemberRow {
  user_id:   string;
  league_id: string;
}

export interface ReminderLeague {
  id:   string;
  name: string;
  slug: string;
}

/** Longest reminder window a user can choose (reminder_preferences CHECK). */
export const MAX_HOURS_BEFORE = 168;

/**
 * Is "now" inside the user's reminder window for this tournament?
 *
 * Reminder window = [deadline - hours_before .. deadline].
 * Returns false if the deadline is missing, in the past, or further
 * out than the user's window.
 */
export function isInsideReminderWindow(args: {
  pickDeadline: Date | null;
  hoursBefore:  number;
  now:          Date;
}): boolean {
  const { pickDeadline, hoursBefore, now } = args;
  if (!pickDeadline) return false;

  const deadlineMs = pickDeadline.getTime();
  const nowMs      = now.getTime();
  if (nowMs > deadlineMs) return false;             // already past deadline

  const windowStart = deadlineMs - hoursBefore * 3600_000;
  return nowMs >= windowStart;
}

/**
 * Pick the right delivery address for a channel, falling back to
 * the user's profile email when no per-channel override is set.
 * Returns null when no destination is configured at all.
 */
export function destinationFor(args: {
  channel:      Channel;
  prefs:        ReminderPreferences;
  profileEmail: string | null;
}): string | null {
  const { channel, prefs, profileEmail } = args;
  switch (channel) {
    case 'email': return prefs.email_addr || profileEmail;
    case 'sms':   return prefs.phone_e164;
    case 'push':  return prefs.push_token;
  }
}

/** Quiet hours (Central): no reminder emails from 10 PM to 7 AM. */
export const QUIET_START_HOUR = 22;
export const QUIET_END_HOUR   = 7;

function centralClock(d: Date): { hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0) % 24;
  return { hour: get('hour'), minute: get('minute'), second: get('second') };
}

/**
 * Hold reminders during quiet hours (10 PM–7 AM Central) and send them
 * at 7 AM — unless the deadline comes before 7 AM, in which case send
 * now (late at night beats not at all). Pick deadlines are often ~1 AM
 * Thursday, so a 24-hour window would otherwise open at 1 AM.
 * (DST-change nights can be off by an hour; harmless.)
 */
export function holdForQuietHours(now: Date, deadline: Date): boolean {
  const { hour, minute, second } = centralClock(now);
  const quiet = hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
  if (!quiet) return false;
  const hoursTo7 = (QUIET_END_HOUR - hour + 24) % 24;
  const next7am = now.getTime() + hoursTo7 * 3600_000 - minute * 60_000 - second * 1000;
  return deadline.getTime() > next7am;
}

/** One reminder email: one per user per tournament, listing every
 *  league where they still haven't picked. */
export interface EmailReminderTask {
  user_id:     string;
  /** null → no address on file; the job logs it as 'skipped'. */
  destination: string | null;
  displayName: string | null;
  /** Leagues (with this tournament on their schedule) missing a pick. */
  leagues:     ReminderLeague[];
}

/**
 * Compute the reminder emails to attempt for one tournament.
 *
 *   - tournament.deadline must be the EFFECTIVE deadline (commissioner
 *     override > computed) — that's when picks actually lock.
 *   - No reminders until the field is published: before that nobody
 *     can pick, so "make your picks" would be wrong.
 *   - `leagues` = leagues with this tournament on their schedule;
 *     members of any other league are ignored.
 *   - `pickedKeys` = `${user_id}:${league_id}` for submitted picks.
 *   - `alreadyHandled` = user_ids whose email reminder for this
 *     tournament is already logged as sent/skipped (a 'failed' row is
 *     NOT in here, so it is retried).
 *   - A user with no prefs row, or email_enabled=false, gets nothing
 *     (matches what the account page shows: no row = off).
 *   - Nothing goes out during quiet hours (see holdForQuietHours).
 */
export function planEmailReminders(args: {
  tournament:     { id: string; status: string; fieldPublished: boolean; deadline: Date | null };
  leagues:        ReminderLeague[];
  members:        MemberRow[];
  pickedKeys:     Set<string>;
  prefsByUser:    Map<string, ReminderPreferences>;
  profileByUser:  Map<string, { email: string | null; display_name: string | null }>;
  alreadyHandled: Set<string>;
  now:            Date;
}): EmailReminderTask[] {
  const { tournament, leagues, members, pickedKeys, prefsByUser, profileByUser, alreadyHandled, now } = args;

  if (tournament.status !== 'upcoming') return [];
  if (!tournament.fieldPublished) return [];
  const deadline = tournament.deadline;
  if (!deadline || Number.isNaN(deadline.getTime())) return [];
  // Anyone whose window opens overnight is picked up by the 7 AM run
  // (their window is still open then).
  if (holdForQuietHours(now, deadline)) return [];

  const leagueById = new Map(leagues.map(l => [l.id, l]));

  // Group by user so a player in several leagues gets ONE email.
  const missingByUser = new Map<string, ReminderLeague[]>();
  for (const m of members) {
    const lg = leagueById.get(m.league_id);
    if (!lg) continue;                                   // tournament not on this league's schedule
    if (pickedKeys.has(`${m.user_id}:${m.league_id}`)) continue;
    const list = missingByUser.get(m.user_id) ?? [];
    if (!list.some(l => l.id === lg.id)) list.push(lg);
    missingByUser.set(m.user_id, list);
  }

  const tasks: EmailReminderTask[] = [];
  for (const [userId, missing] of missingByUser) {
    if (alreadyHandled.has(userId)) continue;
    const prefs = prefsByUser.get(userId);
    if (!prefs || !prefs.email_enabled) continue;
    if (!isInsideReminderWindow({ pickDeadline: deadline, hoursBefore: prefs.hours_before, now })) continue;

    const profile = profileByUser.get(userId);
    tasks.push({
      user_id:     userId,
      destination: destinationFor({ channel: 'email', prefs, profileEmail: profile?.email ?? null }),
      displayName: profile?.display_name ?? null,
      leagues:     [...missing].sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  return tasks.sort((a, b) => a.user_id.localeCompare(b.user_id));
}
