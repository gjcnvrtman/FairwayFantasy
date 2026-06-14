// /api/me/notification-prefs — current user's reminder preferences.
//
// GET  — returns the current row, or a default-valued one if not yet
//        created (every channel OFF, hours_before=24).
// PUT  — upserts the user's row. Caller is the user themselves; we
//        ignore any user_id in the body and use the session's user.id.

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import { requireSameOrigin } from '@/lib/same-origin';
import { isPlatformAdmin } from '@/lib/platform-admin';

// Auth-gated; reads/writes per-user data. Never prerender.
export const dynamic = 'force-dynamic';

const DEFAULT_HOURS_BEFORE = 24;
const MIN_HOURS_BEFORE     = 1;
const MAX_HOURS_BEFORE     = 168;  // 1 week — schema CHECK constraint

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const data = await db.selectFrom('reminder_preferences')
    .selectAll()
    .where('user_id', '=', user.id)
    .executeTakeFirst();

  if (data) return NextResponse.json({ preferences: data });

  // No row yet — return defaults. Don't insert so we don't fill the
  // table with no-op rows for every page view. nightly_recap +
  // tournament_recap default TRUE here to match the DB defaults
  // from migration 009; a missing row is treated as "still opted in".
  return NextResponse.json({
    preferences: {
      user_id:                   user.id,
      email_enabled:             false,
      sms_enabled:               false,
      push_enabled:              false,
      nightly_recap_enabled:     true,
      tournament_recap_enabled:  true,
      hours_before:              DEFAULT_HOURS_BEFORE,
      email_addr:                null,
      phone_e164:                null,
      push_token:                null,
      updated_at:                null,
    },
  });
}

export async function PUT(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));

  // ── Validate + sanitize ──
  const errors: Record<string, string> = {};

  const emailEnabled = typeof body.email_enabled === 'boolean' ? body.email_enabled : false;
  const smsEnabled   = typeof body.sms_enabled   === 'boolean' ? body.sms_enabled   : false;
  const pushEnabled  = typeof body.push_enabled  === 'boolean' ? body.push_enabled  : false;
  // Recap toggles default TRUE when missing from the body so a PUT
  // that only sends `email_enabled` (e.g. an older client, or the
  // upcoming partial-update path) doesn't silently opt the user out.
  const nightlyRecapEnabled    = typeof body.nightly_recap_enabled    === 'boolean' ? body.nightly_recap_enabled    : true;
  const tournamentRecapEnabled = typeof body.tournament_recap_enabled === 'boolean' ? body.tournament_recap_enabled : true;

  let hoursBefore = DEFAULT_HOURS_BEFORE;
  if (typeof body.hours_before === 'number') {
    if (!Number.isInteger(body.hours_before)) {
      errors.hours_before = 'Must be a whole number of hours.';
    } else if (body.hours_before < MIN_HOURS_BEFORE || body.hours_before > MAX_HOURS_BEFORE) {
      errors.hours_before = `Must be between ${MIN_HOURS_BEFORE} and ${MAX_HOURS_BEFORE} hours.`;
    } else {
      hoursBefore = body.hours_before;
    }
  }

  // Optional per-channel destinations. Empty string → null so the
  // default-to-profile-email path kicks in. The email override is
  // gated to platform admins — non-admins are silently coerced to
  // null since the UI doesn't expose the field for them. We resolve
  // the admin check against profiles.email (the DB source of truth)
  // rather than session.email — the JWT is minted at signin and can
  // be stale if the user's email was changed since.
  const profile = await db.selectFrom('profiles')
    .select('email')
    .where('id', '=', user.id)
    .executeTakeFirst();
  const emailAddr = isPlatformAdmin(profile?.email)
    && typeof body.email_addr === 'string'
    && body.email_addr.trim() !== ''
      ? body.email_addr.trim() : null;
  const phoneE164 = typeof body.phone_e164 === 'string' && body.phone_e164.trim() !== ''
    ? body.phone_e164.trim() : null;
  const pushToken = typeof body.push_token === 'string' && body.push_token.trim() !== ''
    ? body.push_token.trim() : null;

  // SMS-without-phone is a configuration error worth surfacing — the
  // notifier would mark every attempt as 'skipped'.
  if (smsEnabled && !phoneE164) {
    errors.phone_e164 = 'Phone number required to enable SMS reminders.';
  }
  if (pushEnabled && !pushToken) {
    errors.push_token = 'Push token required to enable push reminders.';
  }

  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ fieldErrors: errors }, { status: 400 });
  }

  try {
    const data = await db.insertInto('reminder_preferences')
      .values({
        user_id:                   user.id,
        email_enabled:             emailEnabled,
        sms_enabled:               smsEnabled,
        push_enabled:              pushEnabled,
        nightly_recap_enabled:     nightlyRecapEnabled,
        tournament_recap_enabled:  tournamentRecapEnabled,
        hours_before:              hoursBefore,
        email_addr:                emailAddr,
        phone_e164:                phoneE164,
        push_token:                pushToken,
        updated_at:                new Date().toISOString(),
      })
      .onConflict(oc => oc.column('user_id').doUpdateSet(eb => ({
        email_enabled:             eb.ref('excluded.email_enabled'),
        sms_enabled:               eb.ref('excluded.sms_enabled'),
        push_enabled:              eb.ref('excluded.push_enabled'),
        nightly_recap_enabled:     eb.ref('excluded.nightly_recap_enabled'),
        tournament_recap_enabled:  eb.ref('excluded.tournament_recap_enabled'),
        hours_before:              eb.ref('excluded.hours_before'),
        email_addr:                eb.ref('excluded.email_addr'),
        phone_e164:                eb.ref('excluded.phone_e164'),
        push_token:                eb.ref('excluded.push_token'),
        updated_at:                eb.ref('excluded.updated_at'),
      })))
      .returningAll()
      .executeTakeFirstOrThrow();
    return NextResponse.json({ preferences: data });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
