// ============================================================
// WORLD RANKINGS SYNC — now backed by balldontlie.
//
// History:
//   - Originally DataGolf (Scratch Plus paid).
//   - Migrated to ESPN's /pga/rankings (free) — that endpoint died
//     in May 2026 with `{"code":2404,"detail":"http error: not found"}`.
//   - Now balldontlie's /pga/v1/players (free tier — 5 req/min,
//     plenty for a weekly sync). See `src/lib/balldontlie.ts`.
//
// File name kept as `datagolf.ts` to avoid a sweeping rename across
// imports — TODO P1 has an entry to rename this to `rankings.ts`
// once we're stable.
//
// BEHAVIOR vs the old ESPN-backed version:
//   - balldontlie has NO espn_id and NO headshot URL.
//   - We UPDATE existing golfers (matched by name) with the
//     OWGR rank + country code.
//   - We can NOT INSERT new golfers — `golfers.espn_id` is
//     `NOT NULL UNIQUE`, and we don't have that ID from balldontlie.
//     New golfers land in the table via ESPN's leaderboard /
//     field endpoints (score sync, or `scripts/seed-golfers.ts
//     --from-event <id>` for the next upcoming tournament).
//   - The returned `skipped` count tells operators how many ranked
//     players from balldontlie had no matching row in `golfers` —
//     usually the fix is to run an event-field sync first so those
//     players exist locally.
// ============================================================

import { db } from './db';
import { fetchWorldRankings } from './balldontlie';

/**
 * Pull current OWGR rankings from balldontlie and update matching
 * rows in `golfers`. Idempotent — re-running just re-applies the
 * same ranks.
 *
 * Match strategy: exact `display_name` first, then case-insensitive
 * (`ILIKE`) fallback for minor spelling differences between sources.
 */
export async function syncRankingsToDatabase(): Promise<{
  fetched: number;      // total ranked players received from balldontlie
  updated: number;      // golfers rows whose owgr_rank we wrote
  skipped: number;      // ranked players we couldn't find in golfers
  errors:  number;      // DB write failures
}> {
  const players = await fetchWorldRankings({ topN: 200 });

  let updated = 0;
  let skipped = 0;
  let errors  = 0;
  const skippedNames: string[] = [];

  for (const p of players) {
    if (p.owgr === null) continue;
    try {
      const country = p.country_code ?? p.country ?? null;

      // Exact match first.
      let r = await db.updateTable('golfers')
        .set({
          owgr_rank:  p.owgr,
          country,
          updated_at: new Date().toISOString(),
        })
        .where('name', '=', p.display_name)
        .executeTakeFirst();

      // Fallback: case-insensitive (handles "Ludvig Aberg" vs "Ludvig Åberg" — sort of).
      if (Number(r?.numUpdatedRows ?? 0) === 0) {
        r = await db.updateTable('golfers')
          .set({
            owgr_rank:  p.owgr,
            country,
            updated_at: new Date().toISOString(),
          })
          .where('name', 'ilike', p.display_name)
          .executeTakeFirst();
      }

      if (Number(r?.numUpdatedRows ?? 0) > 0) {
        updated++;
      } else {
        skipped++;
        if (skippedNames.length < 25) skippedNames.push(`#${p.owgr} ${p.display_name}`);
      }
    } catch (err) {
      console.error(`Rankings update failed for ${p.display_name}:`, err);
      errors++;
    }
  }

  if (skipped > 0) {
    console.warn(
      `[rankings] ${skipped} ranked players have no matching row in golfers ` +
      `— they need to land via an ESPN event-field sync first. ` +
      `First few: ${skippedNames.slice(0, 10).join('; ')}`,
    );
  }

  return { fetched: players.length, updated, skipped, errors };
}

// ── Dark-horse helpers (used at pick-validation time) ────────

/** Players ranked 25 or beyond are dark horses. Unranked = dark horse too. */
export const DARK_HORSE_CUTOFF = 25;

export function isDarkHorse(owgrRank: number | null): boolean {
  if (owgrRank === null) return true;
  return owgrRank >= DARK_HORSE_CUTOFF;
}
