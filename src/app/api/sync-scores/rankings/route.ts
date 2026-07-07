import { NextRequest, NextResponse } from 'next/server';
import { syncRankingsToDatabase } from '@/lib/rankings';
import { db } from '@/lib/db';

// Weekly cron: syncs OWGR rankings + runs tournament status
// maintenance (upcoming → active → complete based on dates).
//
// Migration 022 removed the ESPN schedule re-import that used to
// run here. The global tournaments table is now populated once at
// league creation (src/lib/schedule-import.ts) and curated per
// league via league_tournaments — see src/app/api/admin/schedule.
// Weekly maintenance still needs to flip status for tournaments
// we already have, so that block stays.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // ── 1. OWGR rankings ──
  let rankingResult: Awaited<ReturnType<typeof syncRankingsToDatabase>> | null = null;
  let rankingError: string | null = null;
  try {
    rankingResult = await syncRankingsToDatabase();
  } catch (err) {
    rankingError = err instanceof Error ? err.message : String(err);
    console.error('Rankings sync failed:', err);
  }

  // ── 2. Tournament status maintenance ──
  // Flip past tournaments → 'complete', arriving tournaments →
  // 'active'. This is a safety net for rows the score sync loop
  // may not touch (e.g. tournaments outside the score-sync date
  // window that were left stale).
  let statusFixes = 0;
  let scheduleError: string | null = null;
  try {
    const completed = await db.updateTable('tournaments')
      .set({ status: 'complete' })
      .where('end_date', '<', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .where('status', '!=', 'complete')
      .executeTakeFirst();
    statusFixes += Number(completed?.numUpdatedRows ?? 0);

    const active = await db.updateTable('tournaments')
      .set({ status: 'active' })
      .where('start_date', '<=', new Date().toISOString())
      .where('end_date',   '>=', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .where('status', '=', 'upcoming')
      .executeTakeFirst();
    statusFixes += Number(active?.numUpdatedRows ?? 0);
  } catch (err) {
    scheduleError = err instanceof Error ? err.message : String(err);
    console.error('Status maintenance failed:', err);
  }

  const anyProgress = (rankingResult && rankingResult.updated > 0)
                   || statusFixes > 0;

  return NextResponse.json(
    {
      success:      anyProgress || (!rankingError && !scheduleError),
      rankings:     rankingResult,
      rankingError,
      statusFixes,
      scheduleError,
    },
    { status: anyProgress || (!rankingError && !scheduleError) ? 200 : 500 },
  );
}
