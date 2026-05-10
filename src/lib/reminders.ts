// ============================================================
// PICK REMINDERS — eligibility logic
// (Prompt 9. Pure functions — no I/O. Caller fetches state and
//  passes it in, then calls the notifier with the result.)
// ============================================================
//
// "Find users who need a pick reminder" is the only non-trivial
// piece of this feature, and it's the part most likely to break
// silently — sending the same reminder twice, or never sending one
// at all. Keeping it pure + tested guards against that.
//
// Architecture (read first):
//   1. A scheduled job (systemd timer or admin button) calls
//      runReminderJob() in `src/lib/reminder-job.ts`.
//   2. That collects state from the DB and passes it to
//      `findUsersDueForReminder()` (this file).
//   3. The eligibility result is fed to the notifier
//      (`src/lib/notifier.ts`), which dispatches per channel.
//   4. The notifier writes a `reminder_log` row per attempt;
//      the next job cycle reads those rows so we don't send twice.

export type Channel = 'email' | 'sms' | 'push';

export const ALL_CHANNELS: readonly Channel[] = ['email', 'sms', 'push'] as const;

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

export interface PickRow {
  league_id:     string;
  tournament_id: string;
  user_id:       string;
}

export interface TournamentRow {
  id:            string;
  status:        string;             // 'upcoming' | 'active' | 'cut_made' | 'complete'
  pick_deadline: string | null;      // ISO 8601
}

/** What channels a user has opted into, given their prefs row. */
export function enabledChannels(prefs: ReminderPreferences): Channel[] {
  const out: Channel[] = [];
  if (prefs.email_enabled) out.push('email');
  if (prefs.sms_enabled)   out.push('sms');
  if (prefs.push_enabled)  out.push('push');
  return out;
}

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
 *
 * Returns null when no destination is configured at all (the caller
 * should log a `skipped` reminder_log row, not throw).
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

/** A single reminder we'd like to deliver. */
export interface ReminderTask {
  user_id:       string;
  league_id:     string;
  tournament_id: string;
  channel:       Channel;
  /** Resolved per-channel destination or null when missing (we still
   *  enqueue so the log captures the skip — see destinationFor). */
  destination:   string | null;
}

/**
 * Compute the list of reminders to attempt for one tournament.
 *
 * Inputs:
 *   - tournament      — the candidate tournament (must be 'upcoming')
 *   - members         — every league member across every league
 *                       picking on this tournament (typically union
 *                       of all league_members.user_id since the
 *                       tournament is global). Each carries the
 *                       league_id we want to log against.
 *   - picksByUserLeague — map of `${user_id}:${league_id}` → pick
 *                       (presence = user has picked, no reminder needed)
 *   - prefsByUser     — map of user_id → ReminderPreferences
 *   - profileEmailByUser — map of user_id → profile email (fallback)
 *   - alreadySent     — set of `${user_id}:${tournament_id}:${channel}`
 *                       keys for past reminder_log entries (idempotency)
 *   - now             — clock injection so tests are deterministic
 *
 * Returns the FULL list of (user × channel) tasks to attempt. The
 * caller then hands the list to the notifier. The notifier records
 * a log row per task so the next cycle's `alreadySent` includes it.
 */
export function findUsersDueForReminder(args: {
  tournament:           TournamentRow;
  members:              MemberRow[];
  picksByUserLeague:    Map<string, PickRow>;
  prefsByUser:          Map<string, ReminderPreferences>;
  profileEmailByUser:   Map<string, string | null>;
  alreadySent:          Set<string>;
  now:                  Date;
}): ReminderTask[] {
  const {
    tournament, members, picksByUserLeague, prefsByUser,
    profileEmailByUser, alreadySent, now,
  } = args;

  // Tournament gate: only `upcoming` tournaments get reminders.
  if (tournament.status !== 'upcoming') return [];
  if (!tournament.pick_deadline) return [];

  const pickDeadline = new Date(tournament.pick_deadline);
  if (Number.isNaN(pickDeadline.getTime())) return [];

  const tasks: ReminderTask[] = [];

  for (const member of members) {
    // Skip if user has picked already in this league.
    const pickKey = `${member.user_id}:${member.league_id}`;
    if (picksByUserLeague.has(pickKey)) continue;

    // Skip if user has no prefs row OR no channels opted in.
    const prefs = prefsByUser.get(member.user_id);
    if (!prefs) continue;

    // Skip if not yet inside the user's window.
    if (!isInsideReminderWindow({
      pickDeadline, hoursBefore: prefs.hours_before, now,
    })) continue;

    const channels = enabledChannels(prefs);
    if (channels.length === 0) continue;

    for (const channel of channels) {
      // Idempotency — never send same (user, tournament, channel) twice.
      const sentKey = `${member.user_id}:${tournament.id}:${channel}`;
      if (alreadySent.has(sentKey)) continue;

      tasks.push({
        user_id:       member.user_id,
        league_id:     member.league_id,
        tournament_id: tournament.id,
        channel,
        destination:   destinationFor({
          channel,
          prefs,
          profileEmail: profileEmailByUser.get(member.user_id) ?? null,
        }),
      });
    }
  }

  return tasks;
}

// ── Helpers for building the input maps from raw DB rows ─────

/** Build the "user has already picked" map keyed by `${user}:${league}`. */
export function buildPicksByUserLeague(picks: PickRow[]): Map<string, PickRow> {
  const m = new Map<string, PickRow>();
  for (const p of picks) m.set(`${p.user_id}:${p.league_id}`, p);
  return m;
}

/** Build the "already-sent" idempotency set from reminder_log rows. */
export function buildAlreadySentSet(rows: Array<{
  user_id:       string;
  tournament_id: string;
  channel:       string;
}>): Set<string> {
  const s = new Set<string>();
  for (const r of rows) s.add(`${r.user_id}:${r.tournament_id}:${r.channel}`);
  return s;
}
