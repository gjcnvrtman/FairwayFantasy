// ============================================================
// NOTIFIER — pluggable delivery for pick reminders.
//
// Today: every channel logs to console + writes a reminder_log row.
// Tomorrow: real email (SMTP), real SMS (Twilio), real push (web push)
// can plug in by implementing the `ChannelDriver` interface.
//
// Safety rule (Prompt 9 acceptance):
//   - "No accidental real messages sent."
//   - We will NEVER call out to a real provider unless
//     `REMINDERS_LIVE === 'true'` AND the channel has a driver
//     registered. Default state: console-only.
// ============================================================

import type { Channel, ReminderTask } from './reminders';

// ── Public types ─────────────────────────────────────────────

export interface NotifyMessage {
  recipient: string;          // resolved per-channel destination
  subject:   string;          // email subject / push title
  body:      string;          // email body / SMS body / push body
}

export interface NotifyResult {
  task:    ReminderTask;
  status:  'console' | 'sent' | 'failed' | 'skipped';
  error?:  string;
}

export interface ChannelDriver {
  /** Returns true if the channel is wired up and configured. */
  isConfigured(): boolean;
  /** Hand off to the underlying provider. Throws on failure. */
  send(msg: NotifyMessage): Promise<void>;
}

// ── Built-in stubs (always safe; never send anything) ────────

/**
 * Console driver — logs the message but doesn't deliver. Used when
 * no real driver is registered for a channel, OR when REMINDERS_LIVE
 * is not set. Reminder_log gets `status: 'console'` so the audit
 * trail still shows what would have happened.
 */
const consoleDriver: ChannelDriver = {
  isConfigured: () => true,
  async send(msg) {
    // eslint-disable-next-line no-console
    console.log(
      `[notifier:console] would send → ${msg.recipient}\n` +
      `  subject: ${msg.subject}\n` +
      `  body:    ${msg.body.slice(0, 200)}${msg.body.length > 200 ? '…' : ''}`,
    );
  },
};

// Real channel drivers register themselves here. Empty by default —
// fill in when a provider is added (env-gated).
const drivers: Partial<Record<Channel, ChannelDriver>> = {};

/** Plug a channel driver. Future use; not called today. */
export function registerDriver(channel: Channel, driver: ChannelDriver): void {
  drivers[channel] = driver;
}

/** Are we permitted to call real providers? Default false. */
export function isLiveMode(): boolean {
  return process.env.REMINDERS_LIVE === 'true';
}

/** Pick the driver to use for a channel. Falls back to console. */
function pickDriver(channel: Channel): { driver: ChannelDriver; isConsole: boolean } {
  const real = drivers[channel];
  if (isLiveMode() && real?.isConfigured()) {
    return { driver: real, isConsole: false };
  }
  return { driver: consoleDriver, isConsole: true };
}

// ── Top-level dispatch ───────────────────────────────────────

/**
 * Send a reminder for one task. Pure-ish: the only side effect is
 * the chosen driver's send() call (console.log in default mode).
 *
 * The CALLER is responsible for writing the reminder_log row —
 * that lets the test suite verify what would have been logged
 * without going near the DB.
 */
export async function dispatchReminder(
  task: ReminderTask,
  buildMessage: (t: ReminderTask) => NotifyMessage,
): Promise<NotifyResult> {
  // No destination = nothing to send. Caller logs `status: 'skipped'`.
  if (!task.destination) {
    return {
      task,
      status: 'skipped',
      error:  `No ${task.channel} destination configured.`,
    };
  }

  const { driver, isConsole } = pickDriver(task.channel);
  const msg = buildMessage(task);

  try {
    await driver.send(msg);
    return { task, status: isConsole ? 'console' : 'sent' };
  } catch (err) {
    return {
      task,
      status: 'failed',
      error:  err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Default message template ─────────────────────────────────

/**
 * Default subject + body for the pick reminder. Channel-aware:
 * SMS bodies are short; email + push get more text.
 */
export function defaultReminderMessage(args: {
  task:           ReminderTask;
  tournamentName: string;
  pickDeadline:   Date;
  pickUrl:        string;
}): NotifyMessage {
  const { task, tournamentName, pickDeadline, pickUrl } = args;
  const human = pickDeadline.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
  const subject = `Submit your picks: ${tournamentName}`;
  if (task.channel === 'sms') {
    return {
      recipient: task.destination ?? '',
      subject,
      body: `Fairway Fantasy: pick deadline for ${tournamentName} is ${human}. Submit: ${pickUrl}`,
    };
  }
  return {
    recipient: task.destination ?? '',
    subject,
    body:
      `Hey — picks for ${tournamentName} lock at ${human}.\n\n` +
      `Submit your foursome:\n${pickUrl}\n\n` +
      `(You're receiving this because you opted into pick reminders. ` +
      `Manage preferences at /settings.)`,
  };
}
