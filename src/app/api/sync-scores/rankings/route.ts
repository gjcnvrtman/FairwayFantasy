import { NextRequest, NextResponse } from 'next/server';
import { syncRankingsToDatabase } from '@/lib/datagolf';
import { db } from '@/lib/db';
import { fetchPGASchedule } from '@/lib/espn';

// Weekly cron: syncs OWGR rankings + imports ESPN schedule
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    // 1. Sync OWGR rankings from DataGolf
    const rankingResult = await syncRankingsToDatabase();

    // 2. Sync PGA Tour schedule from ESPN
    const schedule = await fetchPGASchedule();
    let tournamentsSynced = 0;

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

    return NextResponse.json({
      success: true,
      rankings: rankingResult,
      tournaments: tournamentsSynced,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
