// /api/sync-field — cron-secret-authed field availability poller.
//
// Twin of /api/sync-scores, but fires the upstream `runFieldSync`
// instead. Hourly on Mon-Wed via the systemd `fairway-field.timer`
// (see infra/systemd/fairway-field.*); checks ESPN for each upcoming
// tournament whose `field_published_at` is still NULL, and stamps it
// the first time ESPN returns a non-empty competitors collection.
//
// Cheap when no field is pending — the entry-point query short-
// circuits after one SELECT count.

import { NextRequest, NextResponse } from 'next/server';
import { runFieldSync } from '@/lib/sync';

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const summary = await runFieldSync();
  if (!summary.ok) {
    return NextResponse.json({ error: summary.error }, { status: 500 });
  }
  return NextResponse.json({ success: true, ...summary });
}

export async function GET(req: NextRequest) { return POST(req); }
