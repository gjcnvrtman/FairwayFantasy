// /api/check-field-alert — Tuesday-midnight guardrail.
//
// Fires once a week from `fairway-field-alert.timer` at 00:05 CT
// Wednesday (5 min past Tue midnight). Queries for any non-hidden
// tournament with `field_published_at IS NULL` starting within the
// next 5 days. If any exist, emails the admin so they can decide
// whether to wait, manually trigger the sync, or override the pick
// deadline.
//
// Silent when there's nothing pending — no send, no noise.
//
// The Mon–Wed hourly field poll (fairway-field.timer) won't fire
// again until next Monday, so this alert is the last automated
// signal admin gets before the tournament week starts dark.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sendEmail, fieldNotYetPublishedAlertEmail } from '@/lib/email';

// Alert recipient. Hardcoded to Greg per the 2026-07-23 decision.
// If we ever want MJ on this too, add to the array and adjust the
// loop below to send N emails or one To: with both addresses.
const ALERT_RECIPIENTS = ['gjcnvrtman@gmail.com'];

// How far into the future we consider a tournament "imminent". Five
// days covers a Wed-early-morning fire → Thu/Fri/Sat/Sun starts.
// Longer windows would false-alarm on tournaments ESPN legitimately
// won't publish until closer to the event.
const IMMINENT_WINDOW_DAYS = 5;

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const now     = new Date();
    const horizon = new Date(now.getTime() + IMMINENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const pending = await db.selectFrom('tournaments')
      .select(['id', 'name', 'start_date', 'espn_event_id'])
      .where('field_published_at', 'is', null)
      .where('hidden', '=', false)
      .where('start_date', '>=', now.toISOString())
      .where('start_date', '<=', horizon.toISOString())
      .orderBy('start_date', 'asc')
      .execute();

    if (pending.length === 0) {
      return NextResponse.json({
        success: true,
        alerted: false,
        pendingCount: 0,
        message: 'no pending imminent tournaments — nothing to alert on',
      });
    }

    const { subject, text, html } = fieldNotYetPublishedAlertEmail({
      tournaments: pending.map(t => ({
        name:         t.name,
        startDate:    new Date(t.start_date),
        espnEventId:  t.espn_event_id,
      })),
    });

    const sends = await Promise.all(
      ALERT_RECIPIENTS.map(async to => {
        const ok = await sendEmail({ to, subject, text, html });
        // eslint-disable-next-line no-console
        console.log(`[field-alert] ${pending.length} pending → ${to} sent=${ok}`);
        return { to, ok };
      }),
    );

    const failed = sends.filter(s => !s.ok).length;
    return NextResponse.json({
      success:      failed === 0,
      alerted:      true,
      pendingCount: pending.length,
      pending:      pending.map(t => ({
        name:          t.name,
        start_date:    t.start_date,
        espn_event_id: t.espn_event_id,
      })),
      sends,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[field-alert] check failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) { return POST(req); }
