// /api/admin/sync-scores — commissioner-authed manual sync trigger.
//
// Why this exists:
//   The previous AdminPanel "Sync Now" button posted to
//   /api/sync-scores with `Bearer ${process.env.NEXT_PUBLIC_CRON_SECRET}`.
//   `NEXT_PUBLIC_*` is bundled into the client JS, so the cron secret
//   was readable by any visitor. That's bug #4.1.
//
// Auth model:
//   - Caller must be authenticated (session cookie) AND a
//     commissioner of the league named in the request body.
//   - We don't gate sync to the commissioner's league only — the
//     sync engine processes ALL active tournaments globally — but
//     we DO require commissioner-of-some-league as the trust anchor.
//     A non-commissioner has no business triggering sync.

import { NextRequest, NextResponse } from 'next/server';
import { runScoreSync } from '@/lib/sync';
import { requireCommissioner, isAuthFail } from '@/lib/auth-league';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const leagueId = typeof body.leagueId === 'string' ? body.leagueId : null;
  const slug     = typeof body.slug     === 'string' ? body.slug     : null;

  const auth = await requireCommissioner({ leagueId, slug });
  if (isAuthFail(auth)) return auth.response;

  const summary = await runScoreSync();
  if (!summary.ok) {
    return NextResponse.json({ error: summary.error }, { status: 500 });
  }
  return NextResponse.json({ success: true, ...summary });
}
