import { describe, it, expect } from 'vitest';
import {
  planEmailReminders,
  holdForQuietHours,
  isInsideReminderWindow,
  destinationFor,
  type ReminderPreferences,
  type MemberRow,
  type ReminderLeague,
} from '@/lib/reminders';
import { pickReminderEmail } from '@/lib/email';

// ─────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────

const NOW = new Date('2026-04-09T12:00:00Z');                  // Wed noon UTC
const DEADLINE = new Date('2026-04-10T11:00:00Z');             // Thu 11am = 23h after NOW

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

const LG = (id: string): ReminderLeague => ({ id, name: `League ${id}`, slug: id });

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
// planEmailReminders — who gets a reminder email right now
// ─────────────────────────────────────────────────────────────

type PlanArgs = Parameters<typeof planEmailReminders>[0];
function plan(over: Partial<PlanArgs> = {}) {
  return planEmailReminders({
    tournament:     { id: 'tour1', status: 'upcoming', fieldPublished: true, deadline: DEADLINE },
    leagues:        [LG('lg1')],
    members:        [member('u1')],
    pickedKeys:     new Set(),
    prefsByUser:    new Map([['u1', defaultPrefs()]]),
    profileByUser:  new Map([['u1', { email: 'u1@x', display_name: 'Una' }]]),
    alreadyHandled: new Set(),
    now:            NOW,
    ...over,
  });
}

describe('planEmailReminders — happy path', () => {
  it('opted-in user with no pick, inside their window → one task', () => {
    const tasks = plan();
    expect(tasks).toEqual([{
      user_id: 'u1', destination: 'u1@x', displayName: 'Una', leagues: [LG('lg1')],
    }]);
  });

  it('ONE email for a player missing picks in two leagues, listing both', () => {
    const tasks = plan({
      leagues: [LG('b'), LG('a')],
      members: [member('u1', 'a'), member('u1', 'b')],
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].leagues.map(l => l.id)).toEqual(['a', 'b']);
  });

  it('two leagues, picked in one → reminder lists only the other', () => {
    const tasks = plan({
      leagues: [LG('a'), LG('b')],
      members: [member('u1', 'a'), member('u1', 'b')],
      pickedKeys: new Set(['u1:a']),
    });
    expect(tasks[0].leagues.map(l => l.id)).toEqual(['b']);
  });
});

describe('planEmailReminders — exclusions', () => {
  it('already picked → nothing', () => {
    expect(plan({ pickedKeys: new Set(['u1:lg1']) })).toEqual([]);
  });

  it('league without this tournament on its schedule → ignored', () => {
    expect(plan({ members: [member('u1', 'other-league')] })).toEqual([]);
  });

  it('field not published yet → nothing (players can\'t pick)', () => {
    expect(plan({ tournament: { id: 'tour1', status: 'upcoming', fieldPublished: false, deadline: DEADLINE } })).toEqual([]);
  });

  it.each(['active', 'cut_made', 'complete'])('tournament %s → nothing', status => {
    expect(plan({ tournament: { id: 'tour1', status, fieldPublished: true, deadline: DEADLINE } })).toEqual([]);
  });

  it('no deadline → nothing', () => {
    expect(plan({ tournament: { id: 'tour1', status: 'upcoming', fieldPublished: true, deadline: null } })).toEqual([]);
  });

  it('no prefs row → nothing (account page shows reminders off)', () => {
    expect(plan({ prefsByUser: new Map() })).toEqual([]);
  });

  it('email reminders turned off → nothing, even with sms/push flags set', () => {
    expect(plan({ prefsByUser: new Map([['u1', defaultPrefs({
      email_enabled: false, sms_enabled: true, push_enabled: true, phone_e164: '+15551234567', push_token: 't',
    })]]) })).toEqual([]);
  });

  it('outside the player\'s window → nothing; per-player hours_before respected', () => {
    // NOW is 23h before the deadline.
    expect(plan({ prefsByUser: new Map([['u1', defaultPrefs({ hours_before: 2 })]]) })).toEqual([]);
    expect(plan({ prefsByUser: new Map([['u1', defaultPrefs({ hours_before: 48 })]]) })).toHaveLength(1);
  });

  it('after the deadline → nothing', () => {
    expect(plan({ now: new Date(DEADLINE.getTime() + 1000) })).toEqual([]);
  });

  it('already reminded for this tournament → nothing (never twice)', () => {
    expect(plan({ alreadyHandled: new Set(['u1']) })).toEqual([]);
  });

  it('no email on file → task with null destination (job logs it as skipped)', () => {
    const tasks = plan({ profileByUser: new Map([['u1', { email: null, display_name: null }]]) });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].destination).toBeNull();
  });
});

describe('quiet hours (10 PM – 7 AM Central)', () => {
  // Typical real deadline: Thu 1:00 AM CDT = 06:00Z.
  const dl = new Date('2026-10-01T06:00:00Z');
  const at = (iso: string) => new Date(iso);

  it('holds overnight when 7 AM is still before the deadline', () => {
    expect(holdForQuietHours(at('2026-09-30T06:00:00Z'), dl)).toBe(true);   // Wed 1:00 AM CDT
    expect(holdForQuietHours(at('2026-09-30T03:30:00Z'), dl)).toBe(true);   // Tue 10:30 PM CDT
  });
  it('sends from 7 AM on', () => {
    expect(holdForQuietHours(at('2026-09-30T12:00:00Z'), dl)).toBe(false);  // Wed 7:00 AM CDT
    expect(holdForQuietHours(at('2026-09-30T20:00:00Z'), dl)).toBe(false);  // Wed 3:00 PM CDT
  });
  it('sends at night anyway when the deadline comes before 7 AM', () => {
    expect(holdForQuietHours(at('2026-10-01T03:30:00Z'), dl)).toBe(false);  // Wed 10:30 PM, deadline 1 AM
  });
  it('planner: 24h player on a 1 AM deadline → nothing at 1 AM, reminded at 7 AM', () => {
    const t = { id: 'tour1', status: 'upcoming', fieldPublished: true, deadline: dl };
    expect(plan({ tournament: t, now: at('2026-09-30T06:05:00Z') })).toEqual([]);
    expect(plan({ tournament: t, now: at('2026-09-30T12:00:00Z') })).toHaveLength(1);
  });
});

describe('planEmailReminders — busy roster', () => {
  it('only the opted-in, unpicked, in-window players are reminded', () => {
    const tasks = plan({
      members: ['alice', 'bob', 'carol', 'dave'].map(u => member(u)),
      pickedKeys: new Set(['bob:lg1']),
      prefsByUser: new Map([
        ['alice', defaultPrefs({ user_id: 'alice' })],
        ['bob',   defaultPrefs({ user_id: 'bob' })],                       // picked
        // carol: no prefs row
        ['dave',  defaultPrefs({ user_id: 'dave', email_enabled: false })], // off
      ]),
      profileByUser: new Map(['alice', 'bob', 'carol', 'dave'].map(u => [u, { email: `${u}@x`, display_name: u }])),
    });
    expect(tasks.map(t => t.user_id)).toEqual(['alice']);
  });
});

// ─────────────────────────────────────────────────────────────
// pickReminderEmail — template
// ─────────────────────────────────────────────────────────────

describe('pickReminderEmail', () => {
  const deadline = new Date('2026-10-01T12:00:00Z');   // 7:00 AM CDT
  it('one league: league in subject, picks link, deadline in Central time', () => {
    const e = pickReminderEmail({
      recipientName: 'Greg', tournamentName: 'Sanderson Farms', pickDeadline: deadline,
      leagues: [{ name: 'Gunga Galunga', slug: 'gunga-galunga-gang' }], siteUrl: 'https://x.test',
    });
    expect(e.subject).toBe('[Gunga Galunga] Reminder: make your picks for Sanderson Farms');
    expect(e.text).toContain('https://x.test/league/gunga-galunga-gang/picks');
    expect(e.text).toMatch(/7:00\s?AM CDT/);
    expect(e.html).toContain('href="https://x.test/league/gunga-galunga-gang/picks"');
  });
  it('several leagues: one link per league, count in subject', () => {
    const e = pickReminderEmail({
      recipientName: 'Greg', tournamentName: 'Sanderson Farms', pickDeadline: deadline,
      leagues: [{ name: 'A', slug: 'a' }, { name: 'B', slug: 'b' }], siteUrl: 'https://x.test',
    });
    expect(e.subject).toContain('(2 leagues)');
    expect(e.text).toContain('A: https://x.test/league/a/picks');
    expect(e.text).toContain('B: https://x.test/league/b/picks');
  });
  it('escapes HTML in names', () => {
    const e = pickReminderEmail({
      recipientName: '<b>x</b>', tournamentName: 'T', pickDeadline: deadline,
      leagues: [{ name: 'A&B', slug: 'ab' }], siteUrl: 'https://x.test',
    });
    expect(e.html).not.toContain('<b>x</b>');
    expect(e.html).toContain('A&amp;B');
  });
});

