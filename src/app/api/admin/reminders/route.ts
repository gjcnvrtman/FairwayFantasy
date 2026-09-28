// /api/admin/reminders — pick-reminder cycle trigger.
//
// Auth: TWO modes accepted, in order of preference:
//   1. Bearer CRON_SECRET — fairway-reminders.timer (every 15 min).
//   2. Co-commissioner-or-above session — manual run (POST only).
//
// Either way the actual work is done by `runReminderJob()`, which only
// emails players who are inside their own reminder window and haven't
// been reminded for that tournament yet — so a manual run can't spam.

import { NextRequest, NextResponse } from 'next/server';
import { runReminderJob } from '@/lib/reminder-job';
import { requireCoCommissionerOrAbove, isAuthFail } from '@/lib/auth-league';
import { requireSameOrigin } from '@/lib/same-origin';

export async function POST(req: NextRequest) {
  // Same-origin check is fail-open on missing Origin, so the systemd
  // timer's Bearer path (curl with no Origin header) passes through
  // unaffected — only browser requests get CSRF-checked, and those
  // hit the commissioner-session path below.
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  // ── Auth path 1: cron secret ──
  const authHeader = req.headers.get('authorization');
  if (authHeader && authHeader === `Bearer ${process.env.CRON_SECRET}`) {
    const summary = await runReminderJob();
    return NextResponse.json({ via: 'cron', ...summary }, {
      status: summary.ok ? 200 : 500,
    });
  }

  // ── Auth path 2: commissioner session ──
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const leagueId = typeof body.leagueId === 'string' ? body.leagueId : null;
  const slug     = typeof body.slug     === 'string' ? body.slug     : null;

  const auth = await requireCoCommissionerOrAbove({ leagueId, slug });
  if (isAuthFail(auth)) return auth.response;

  const summary = await runReminderJob();
  return NextResponse.json({ via: 'commissioner', ...summary }, {
    status: summary.ok ? 200 : 500,
  });
}

// GET kept for simple curl/timer invocations, but ONLY with the cron
// secret. A session-authed GET would be a one-click CSRF (SameSite=Lax
// sends the cookie on top-level navigations, and requireSameOrigin
// fails open when a no-referrer link strips Origin + Referer), so the
// commissioner button must use POST.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Use POST.' }, { status: 405, headers: { Allow: 'POST' } });
  }
  return POST(req);
}
