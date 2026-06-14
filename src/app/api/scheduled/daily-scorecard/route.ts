// /api/scheduled/daily-scorecard — cron-secret-authed daily-scorecard
// sweep, fired by fairway-daily-scorecard.timer at 7:00pm CT Thu-Sun.
//
// Split from /api/sync-scores so the score sync can keep its every-10-min
// cadence (live leaderboard updates) without coupling the scorecard
// emails to it. Idempotent via daily_scorecard_log — safe to re-run.

import { NextRequest, NextResponse } from 'next/server';
import { detectAndSendDailyScorecards } from '@/lib/sync';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    await detectAndSendDailyScorecards();
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) { return POST(req); }
