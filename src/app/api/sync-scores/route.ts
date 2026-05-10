// /api/sync-scores — cron-secret-authed sync (called by systemd timer
// in LAN deployment, or any external scheduler).
//
// The actual sync logic lives in `@/lib/sync`. The admin "Sync Now"
// button in the commissioner panel uses `/api/admin/sync-scores`
// instead — that path is session-authed, so the cron secret never
// has to leave the server.

import { NextRequest, NextResponse } from 'next/server';
import { runScoreSync } from '@/lib/sync';

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const summary = await runScoreSync();
  if (!summary.ok) {
    return NextResponse.json({ error: summary.error }, { status: 500 });
  }
  return NextResponse.json({ success: true, ...summary });
}

export async function GET(req: NextRequest) { return POST(req); }
