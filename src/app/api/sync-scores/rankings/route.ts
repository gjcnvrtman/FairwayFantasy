import { NextRequest, NextResponse } from 'next/server';
import { syncRankingsToDatabase } from '@/lib/rankings';
import { db } from '@/lib/db';
import { fetchPGASchedule } from '@/lib/espn';

// Weekly cron: syncs OWGR rankings + imports ESPN schedule
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Partial-success: rankings and schedule sync are independent. If
  // ESPN's rankings endpoint is down (it returned 500 in May 2026)
  // we still want the schedule to populate so the dashboard works.
  // Each step's failure is captured but doesn't abort the other.

  // ── 1. OWGR rankings ──
  let rankingResult: Awaited<ReturnType<typeof syncRankingsToDatabase>> | null = null;
  let rankingError: string | null = null;
  try {
    rankingResult = await syncRankingsToDatabase();
  } catch (err) {
    rankingError = err instanceof Error ? err.message : String(err);
    console.error('Rankings sync failed:', err);
  }

  // ── 2. PGA Tour schedule ──
  let tournamentsSynced  = 0;
  let scheduleError: string | null = null;
  let statusFixes        = 0;
  try {
    const schedule = await fetchPGASchedule();
    for (const event of schedule) {
      try {
        // Pick deadline = Thursday 7am ET (roughly first tee time —
        // approx start_date - 1h). Bug #3.6 tracks the more precise
        // per-tournament tee-time approach.
        const pickDeadline = new Date(
          new Date(event.start_date).getTime() - 60 * 60 * 1000,
        ).toISOString();

        await db.insertInto('tournaments')
          .values({
            espn_event_id: event.espn_event_id,
            name:          event.name,
            type:          event.type,
            season:        event.season,
            start_date:    event.start_date,
            end_date:      event.end_date,
            pick_deadline: pickDeadline,
          })
          .onConflict(oc => oc.column('espn_event_id').doUpdateSet(eb => ({
            name:          eb.ref('excluded.name'),
            type:          eb.ref('excluded.type'),
            season:        eb.ref('excluded.season'),
            start_date:    eb.ref('excluded.start_date'),
            end_date:      eb.ref('excluded.end_date'),
            pick_deadline: eb.ref('excluded.pick_deadline'),
          })))
          .execute();
        tournamentsSynced++;
      } catch (innerErr) {
        console.error(
          `Tournament upsert failed for ${event.name}:`,
          innerErr,
        );
      }
    }

    // ── 2b. Status maintenance ─────────────────────────────
    // Schedule upsert inserts tournaments with default status='upcoming'.
    // The score sync only updates tournaments in the current date
    // window (start_date <= now AND end_date >= now-1d), so PAST
    // tournaments stay marked 'upcoming' forever — and the dashboard
    // picks page grabs the earliest 'upcoming' row as "next event,"
    // which is January's Sentry Tournament. Flip stale rows here.
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
    console.error('Schedule sync failed:', err);
  }

  // ── Decide HTTP status ──
  // - 200 if at least one of the two sub-syncs produced data.
  // - 500 only if BOTH failed (genuinely no progress).
  const anyProgress = (rankingResult && rankingResult.updated > 0)
                   || tournamentsSynced > 0
                   || statusFixes > 0;

  return NextResponse.json(
    {
      success:           anyProgress || (!rankingError && !scheduleError),
      rankings:          rankingResult,
      rankingError,
      tournaments:       tournamentsSynced,
      statusFixes,
      scheduleError,
    },
    { status: anyProgress || (!rankingError && !scheduleError) ? 200 : 500 },
  );
}
