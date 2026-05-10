// /api/admin/reminders — manual + scheduled reminder cycle trigger.
//
// Auth: TWO modes accepted, in order of preference:
//   1. Bearer CRON_SECRET — for the systemd timer (server-to-server).
//   2. Commissioner session — for the admin "Send reminders now" button
//      (manual cycle).
//
// Either way the actual work is done by `runReminderJob()`.

import { NextRequest, NextResponse } from 'next/server';
import { runReminderJob } from '@/lib/reminder-job';
import { requireCommissioner, isAuthFail } from '@/lib/auth-league';

export async function POST(req: NextRequest) {
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

  const auth = await requireCommissioner({ leagueId, slug });
  if (isAuthFail(auth)) return auth.response;

  const summary = await runReminderJob();
  return NextResponse.json({ via: 'commissioner', ...summary }, {
    status: summary.ok ? 200 : 500,
  });
}

// GET aliased to POST for compatibility with simple curl/timer invocations.
export async function GET(req: NextRequest) { return POST(req); }
