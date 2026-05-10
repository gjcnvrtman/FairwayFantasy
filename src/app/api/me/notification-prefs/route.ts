// /api/me/notification-prefs — current user's reminder preferences.
//
// GET  — returns the current row, or a default-valued one if not yet
//        created (every channel OFF, hours_before=24).
// PUT  — upserts the user's row. Caller is the user themselves; we
//        ignore any user_id in the body and use the session's user.id.

import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import { supabaseAdmin } from '@/lib/supabase';

// Auth-gated; reads/writes per-user data. Never prerender.
export const dynamic = 'force-dynamic';

const DEFAULT_HOURS_BEFORE = 24;
const MIN_HOURS_BEFORE     = 1;
const MAX_HOURS_BEFORE     = 168;  // 1 week — schema CHECK constraint

export async function GET() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data } = await supabaseAdmin
    .from('reminder_preferences')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (data) return NextResponse.json({ preferences: data });

  // No row yet — return defaults. Don't insert so we don't fill the
  // table with no-op rows for every page view.
  return NextResponse.json({
    preferences: {
      user_id:       user.id,
      email_enabled: false,
      sms_enabled:   false,
      push_enabled:  false,
      hours_before:  DEFAULT_HOURS_BEFORE,
      email_addr:    null,
      phone_e164:    null,
      push_token:    null,
      updated_at:    null,
    },
  });
}

export async function PUT(req: NextRequest) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));

  // ── Validate + sanitize ──
  const errors: Record<string, string> = {};

  const emailEnabled = typeof body.email_enabled === 'boolean' ? body.email_enabled : false;
  const smsEnabled   = typeof body.sms_enabled   === 'boolean' ? body.sms_enabled   : false;
  const pushEnabled  = typeof body.push_enabled  === 'boolean' ? body.push_enabled  : false;

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
  // default-to-profile-email path kicks in.
  const emailAddr = typeof body.email_addr === 'string' && body.email_addr.trim() !== ''
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

  const { data, error } = await supabaseAdmin
    .from('reminder_preferences')
    .upsert({
      user_id:        user.id,
      email_enabled:  emailEnabled,
      sms_enabled:    smsEnabled,
      push_enabled:   pushEnabled,
      hours_before:   hoursBefore,
      email_addr:     emailAddr,
      phone_e164:     phoneE164,
      push_token:     pushToken,
      updated_at:     new Date().toISOString(),
    }, { onConflict: 'user_id' })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ preferences: data });
}
