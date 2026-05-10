import { describe, it, expect } from 'vitest';
import {
  findUsersDueForReminder,
  enabledChannels,
  isInsideReminderWindow,
  destinationFor,
  buildPicksByUserLeague,
  buildAlreadySentSet,
  type ReminderPreferences,
  type MemberRow,
  type PickRow,
  type TournamentRow,
} from '@/lib/reminders';

// ─────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────

const NOW = new Date('2026-04-09T12:00:00Z');                  // Wed noon UTC
const DEADLINE = new Date('2026-04-10T11:00:00Z').toISOString(); // Thu 11am
//   = 23h after NOW

function tournamentUpcoming(extra: Partial<TournamentRow> = {}): TournamentRow {
  return {
    id:            'tour1',
    status:        'upcoming',
    pick_deadline: DEADLINE,
    ...extra,
  };
}

function defaultPrefs(extra: Partial<ReminderPreferences> = {}): ReminderPreferences {
  return {
    user_id:       'u1',
    email_enabled: true,
    sms_enabled:   false,
    push_enabled:  false,
    hours_before:  24,
    email_addr:    null,
    phone_e164:    null,
    push_token:    null,
    ...extra,
  };
}

function member(user_id: string, league_id = 'lg1'): MemberRow {
  return { user_id, league_id };
}

// ─────────────────────────────────────────────────────────────
// enabledChannels
// ─────────────────────────────────────────────────────────────

describe('enabledChannels', () => {
  it('returns [] when no channels enabled', () => {
    expect(enabledChannels(defaultPrefs({
      email_enabled: false, sms_enabled: false, push_enabled: false,
    }))).toEqual([]);
  });

  it('returns just email when only email is on', () => {
    expect(enabledChannels(defaultPrefs({ email_enabled: true }))).toEqual(['email']);
  });

  it('preserves the canonical order email/sms/push', () => {
    expect(enabledChannels(defaultPrefs({
      email_enabled: true, sms_enabled: true, push_enabled: true,
    }))).toEqual(['email', 'sms', 'push']);
  });
});

// ─────────────────────────────────────────────────────────────
// isInsideReminderWindow
// ─────────────────────────────────────────────────────────────

describe('isInsideReminderWindow', () => {
  const deadline = new Date('2026-04-10T11:00:00Z');

  it('returns false when no deadline set', () => {
    expect(isInsideReminderWindow({
      pickDeadline: null, hoursBefore: 24, now: NOW,
    })).toBe(false);
  });

  it('returns false when now is past the deadline', () => {
    expect(isInsideReminderWindow({
      pickDeadline: deadline,
      hoursBefore:  24,
      now:          new Date('2026-04-10T11:00:01Z'), // 1 sec past
    })).toBe(false);
  });

  it('returns false when now is before the window starts', () => {
    expect(isInsideReminderWindow({
      pickDeadline: deadline,
      hoursBefore:  6,                                    // window: 5am-11am Thu
      now:          new Date('2026-04-10T04:30:00Z'),     // 4:30am — too early
    })).toBe(false);
  });

  it('returns true when now is exactly at the window start (boundary)', () => {
    expect(isInsideReminderWindow({
      pickDeadline: deadline,
      hoursBefore:  24,
      now:          new Date('2026-04-09T11:00:00Z'),     // exactly 24h before
    })).toBe(true);
  });

  it('returns true when now is inside the window', () => {
    expect(isInsideReminderWindow({
      pickDeadline: deadline,
      hoursBefore:  24,
      now:          new Date('2026-04-09T18:00:00Z'),     // 17h before
    })).toBe(true);
  });

  it('returns true when now is right at the deadline (boundary)', () => {
    expect(isInsideReminderWindow({
      pickDeadline: deadline,
      hoursBefore:  24,
      now:          deadline,
    })).toBe(true);
  });

  it('windowing respects per-user hours_before', () => {
    // Same now, same deadline, different hours_before:
    //   user A: hours_before=2 → window = 9-11am Thu → NOW (Wed noon) is OUTSIDE
    //   user B: hours_before=48 → window = Tue 11am – Thu 11am → NOW INSIDE
    const userA = isInsideReminderWindow({ pickDeadline: deadline, hoursBefore: 2,  now: NOW });
    const userB = isInsideReminderWindow({ pickDeadline: deadline, hoursBefore: 48, now: NOW });
    expect(userA).toBe(false);
    expect(userB).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// destinationFor
// ─────────────────────────────────────────────────────────────

describe('destinationFor', () => {
  it('falls back to profile email when email_addr is null', () => {
    expect(destinationFor({
      channel:      'email',
      prefs:        defaultPrefs({ email_addr: null }),
      profileEmail: 'fallback@example.com',
    })).toBe('fallback@example.com');
  });

  it('uses email_addr override when present', () => {
    expect(destinationFor({
      channel:      'email',
      prefs:        defaultPrefs({ email_addr: 'override@example.com' }),
      profileEmail: 'fallback@example.com',
    })).toBe('override@example.com');
  });

  it('returns null for sms with no phone', () => {
    expect(destinationFor({
      channel:      'sms',
      prefs:        defaultPrefs({ phone_e164: null }),
      profileEmail: 'irrelevant@example.com',
    })).toBeNull();
  });

  it('returns null for push with no token', () => {
    expect(destinationFor({
      channel:      'push',
      prefs:        defaultPrefs({ push_token: null }),
      profileEmail: 'irrelevant@example.com',
    })).toBeNull();
  });

  it('returns null for email with no fallback either', () => {
    expect(destinationFor({
      channel:      'email',
      prefs:        defaultPrefs({ email_addr: null }),
      profileEmail: null,
    })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// findUsersDueForReminder — the core eligibility decider
// ─────────────────────────────────────────────────────────────

describe('findUsersDueForReminder — basic happy path', () => {
  it('returns one task for an opted-in user with no pick yet', () => {
    const tournament = tournamentUpcoming();
    const tasks = findUsersDueForReminder({
      tournament,
      members: [member('u1')],
      picksByUserLeague:  new Map(),
      prefsByUser:        new Map([['u1', defaultPrefs()]]),
      profileEmailByUser: new Map([['u1', 'u1@example.com']]),
      alreadySent:        new Set(),
      now:                NOW,
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].user_id).toBe('u1');
    expect(tasks[0].channel).toBe('email');
    expect(tasks[0].destination).toBe('u1@example.com');
  });

  it('returns one task per enabled channel', () => {
    const tasks = findUsersDueForReminder({
      tournament: tournamentUpcoming(),
      members:    [member('u1')],
      picksByUserLeague:  new Map(),
      prefsByUser:        new Map([['u1', defaultPrefs({
        email_enabled: true, sms_enabled: true, push_enabled: true,
        phone_e164: '+15551234567', push_token: 'tok123',
      })]]),
      profileEmailByUser: new Map([['u1', 'u1@example.com']]),
      alreadySent:        new Set(),
      now:                NOW,
    });
    expect(tasks).toHaveLength(3);
    expect(tasks.map(t => t.channel)).toEqual(['email', 'sms', 'push']);
  });
});

describe('findUsersDueForReminder — exclusions', () => {
  it('excludes users with no prefs row at all', () => {
    const tasks = findUsersDueForReminder({
      tournament: tournamentUpcoming(),
      members:    [member('u1')],
      picksByUserLeague:  new Map(),
      prefsByUser:        new Map(),                   // u1 not in map
      profileEmailByUser: new Map([['u1', 'u1@x']]),
      alreadySent:        new Set(),
      now:                NOW,
    });
    expect(tasks).toEqual([]);
  });

  it('excludes users with prefs row but no channels enabled', () => {
    const tasks = findUsersDueForReminder({
      tournament: tournamentUpcoming(),
      members:    [member('u1')],
      picksByUserLeague:  new Map(),
      prefsByUser:        new Map([['u1', defaultPrefs({
        email_enabled: false, sms_enabled: false, push_enabled: false,
      })]]),
      profileEmailByUser: new Map([['u1', 'u1@x']]),
      alreadySent:        new Set(),
      now:                NOW,
    });
    expect(tasks).toEqual([]);
  });

  it('excludes users who already submitted a pick for this league/tournament', () => {
    const pick: PickRow = { user_id: 'u1', league_id: 'lg1', tournament_id: 'tour1' };
    const tasks = findUsersDueForReminder({
      tournament: tournamentUpcoming(),
      members:    [member('u1', 'lg1')],
      picksByUserLeague:  buildPicksByUserLeague([pick]),
      prefsByUser:        new Map([['u1', defaultPrefs()]]),
      profileEmailByUser: new Map([['u1', 'u1@x']]),
      alreadySent:        new Set(),
      now:                NOW,
    });
    expect(tasks).toEqual([]);
  });

  it('still reminds the user in League B if they only picked in League A', () => {
    // Same person plays in two leagues. Picked in lgA, not lgB.
    const pickA: PickRow = { user_id: 'u1', league_id: 'lgA', tournament_id: 'tour1' };
    const tasks = findUsersDueForReminder({
      tournament: tournamentUpcoming(),
      members:    [member('u1', 'lgA'), member('u1', 'lgB')],
      picksByUserLeague:  buildPicksByUserLeague([pickA]),
      prefsByUser:        new Map([['u1', defaultPrefs()]]),
      profileEmailByUser: new Map([['u1', 'u1@x']]),
      alreadySent:        new Set(),
      now:                NOW,
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].league_id).toBe('lgB');
  });

  it('skips entirely when tournament status is not upcoming', () => {
    for (const status of ['active', 'cut_made', 'complete']) {
      const tasks = findUsersDueForReminder({
        tournament: tournamentUpcoming({ status }),
        members:    [member('u1')],
        picksByUserLeague:  new Map(),
        prefsByUser:        new Map([['u1', defaultPrefs()]]),
        profileEmailByUser: new Map([['u1', 'u1@x']]),
        alreadySent:        new Set(),
        now:                NOW,
      });
      expect(tasks).toEqual([]);
    }
  });

  it('skips when tournament has no pick_deadline', () => {
    const tasks = findUsersDueForReminder({
      tournament: tournamentUpcoming({ pick_deadline: null }),
      members:    [member('u1')],
      picksByUserLeague:  new Map(),
      prefsByUser:        new Map([['u1', defaultPrefs()]]),
      profileEmailByUser: new Map([['u1', 'u1@x']]),
      alreadySent:        new Set(),
      now:                NOW,
    });
    expect(tasks).toEqual([]);
  });

  it('skips when now is outside the user\'s reminder window', () => {
    // hours_before=2: window starts at deadline-2h. NOW is 23h before.
    const tasks = findUsersDueForReminder({
      tournament: tournamentUpcoming(),
      members:    [member('u1')],
      picksByUserLeague:  new Map(),
      prefsByUser:        new Map([['u1', defaultPrefs({ hours_before: 2 })]]),
      profileEmailByUser: new Map([['u1', 'u1@x']]),
      alreadySent:        new Set(),
      now:                NOW,
    });
    expect(tasks).toEqual([]);
  });
});

describe('findUsersDueForReminder — idempotency', () => {
  it('skips a (user, tournament, channel) that is already in alreadySent', () => {
    const tasks = findUsersDueForReminder({
      tournament: tournamentUpcoming(),
      members:    [member('u1')],
      picksByUserLeague:  new Map(),
      prefsByUser:        new Map([['u1', defaultPrefs()]]),
      profileEmailByUser: new Map([['u1', 'u1@x']]),
      alreadySent:        new Set(['u1:tour1:email']),  // already sent
      now:                NOW,
    });
    expect(tasks).toEqual([]);
  });

  it('still sends on a NEW channel when only one channel was already sent', () => {
    const tasks = findUsersDueForReminder({
      tournament: tournamentUpcoming(),
      members:    [member('u1')],
      picksByUserLeague:  new Map(),
      prefsByUser:        new Map([['u1', defaultPrefs({
        email_enabled: true, sms_enabled: true, phone_e164: '+15551234567',
      })]]),
      profileEmailByUser: new Map([['u1', 'u1@x']]),
      alreadySent:        new Set(['u1:tour1:email']),  // email sent, sms hasn't
      now:                NOW,
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].channel).toBe('sms');
  });

  it('buildAlreadySentSet builds the right key shape', () => {
    const set = buildAlreadySentSet([
      { user_id: 'u1', tournament_id: 'tour1', channel: 'email' },
      { user_id: 'u1', tournament_id: 'tour1', channel: 'sms' },
      { user_id: 'u2', tournament_id: 'tour1', channel: 'email' },
    ]);
    expect(set.has('u1:tour1:email')).toBe(true);
    expect(set.has('u1:tour1:sms')).toBe(true);
    expect(set.has('u2:tour1:email')).toBe(true);
    expect(set.has('u2:tour1:sms')).toBe(false);
  });
});

describe('findUsersDueForReminder — destination handling', () => {
  it('still emits a task for SMS even when phone is null (so the log captures the skip)', () => {
    // Design choice: we emit the task with destination=null and let
    // the notifier mark it as `skipped`. That gives operators a clear
    // audit trail of "tried to remind, but they hadn't set a phone."
    const tasks = findUsersDueForReminder({
      tournament: tournamentUpcoming(),
      members:    [member('u1')],
      picksByUserLeague:  new Map(),
      prefsByUser:        new Map([['u1', defaultPrefs({
        email_enabled: false, sms_enabled: true, phone_e164: null,
      })]]),
      profileEmailByUser: new Map([['u1', 'u1@x']]),
      alreadySent:        new Set(),
      now:                NOW,
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].channel).toBe('sms');
    expect(tasks[0].destination).toBeNull();
  });
});

describe('findUsersDueForReminder — multi-user', () => {
  it('handles a busy roster: some pickers, some not, mix of channels', () => {
    const members = [
      member('alice', 'lg1'),
      member('bob',   'lg1'),
      member('carol', 'lg1'),
      member('dave',  'lg1'),
    ];
    const tasks = findUsersDueForReminder({
      tournament: tournamentUpcoming(),
      members,
      // Bob already picked.
      picksByUserLeague: buildPicksByUserLeague([
        { user_id: 'bob', league_id: 'lg1', tournament_id: 'tour1' },
      ]),
      prefsByUser: new Map([
        // Alice: email on
        ['alice', defaultPrefs({ email_enabled: true })],
        // Bob:   email on (but already picked, should be skipped)
        ['bob',   defaultPrefs({ email_enabled: true })],
        // Carol: NO prefs row → should be skipped
        // Dave:  prefs row but all channels off
        ['dave',  defaultPrefs({ email_enabled: false })],
      ]),
      profileEmailByUser: new Map([
        ['alice', 'alice@x'], ['bob', 'bob@x'],
        ['carol', 'carol@x'], ['dave', 'dave@x'],
      ]),
      alreadySent: new Set(),
      now:         NOW,
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].user_id).toBe('alice');
  });
});

// ─────────────────────────────────────────────────────────────
// Privacy / safety regression — never send when nothing opted in
// ─────────────────────────────────────────────────────────────

describe('findUsersDueForReminder — privacy invariant', () => {
  it('returns no tasks when EVERY user has all channels off (full roster)', () => {
    const allOff = (id: string): [string, ReminderPreferences] => [
      id, defaultPrefs({
        user_id: id,
        email_enabled: false, sms_enabled: false, push_enabled: false,
      }),
    ];
    const tasks = findUsersDueForReminder({
      tournament: tournamentUpcoming(),
      members:    [member('u1'), member('u2'), member('u3')],
      picksByUserLeague:  new Map(),
      prefsByUser:        new Map([allOff('u1'), allOff('u2'), allOff('u3')]),
      profileEmailByUser: new Map([['u1', 'u1@x'], ['u2', 'u2@x'], ['u3', 'u3@x']]),
      alreadySent:        new Set(),
      now:                NOW,
    });
    expect(tasks).toEqual([]);
  });
});
