// ============================================================
// SCHEDULE IMPORT — one-shot pull of the PGA calendar from ESPN
// into the global `tournaments` table. Called once per league at
// creation time (src/app/api/leagues/route.ts). The pre-022
// weekly cron that re-ran this on every rankings sync was
// removed in the same commit.
//
// Why one-shot instead of weekly:
//   - The calendar is stable within a season. Weekly re-import
//     was mostly a no-op that occasionally caused churn (name
//     casing changes, opposite-field events reappearing).
//   - Commissioners now curate per-league schedules via
//     `league_tournaments`; the ESPN dump is only the seed for
//     the picker. Refreshing it under their feet without asking
//     was the wrong default.
//
// Status maintenance (upcoming→active→complete flips based on
// dates) stays in the weekly rankings route — that only touches
// rows we already have.
// ============================================================

import { db } from '@/lib/db';
import { fetchPGASchedule } from '@/lib/espn';

export interface ScheduleImportResult {
  fetched:   number;   // events returned by ESPN
  upserted:  number;   // rows upserted into tournaments (new + updated)
  errors:    number;   // per-event failures (upsert threw)
}

/**
 * Fetch the ESPN PGA calendar and upsert each event into the
 * global `tournaments` table. Idempotent — safe to call as many
 * times as needed; the ON CONFLICT clause updates the name /
 * dates / type on repeat calls without touching status,
 * field_published_at, or any other stateful column.
 */
export async function importPGAScheduleFromESPN(): Promise<ScheduleImportResult> {
  const schedule = await fetchPGASchedule();

  let upserted = 0;
  let errors   = 0;
  for (const event of schedule) {
    try {
      // Pick deadline = Thursday 7am ET approx (event.start_date - 1h).
      // Same heuristic the pre-022 cron used; commissioners can override
      // per-tournament from AdminPanel.
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
      upserted++;
    } catch (err) {
      errors++;
      console.error(`Tournament upsert failed for ${event.name}:`, err);
    }
  }

  return { fetched: schedule.length, upserted, errors };
}
