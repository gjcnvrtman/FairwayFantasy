// ============================================================
// WORLD RANKINGS CLIENT — powered by ESPN (free, no API key)
// Replaces DataGolf — no Scratch Plus membership needed.
//
// ESPN endpoint:
//   https://site.web.api.espn.com/apis/site/v2/sports/golf/pga/rankings
//
// Called once per week by the /api/sync-scores/rankings cron job.
// ============================================================

import { db } from './db';

const ESPN_RANKINGS_URL =
  'https://site.web.api.espn.com/apis/site/v2/sports/golf/pga/rankings';

// ── Types ────────────────────────────────────────────────────

interface ESPNRankingEntry {
  current: number;          // OWGR rank
  athlete: {
    id: string;             // ESPN player ID
    displayName: string;    // "Scottie Scheffler"
    flag?: { alt?: string }; // country abbreviation
    headshot?: { href: string };
  };
}

interface ESPNRankingsResponse {
  rankings: ESPNRankingEntry[];
}

// ── Fetch ────────────────────────────────────────────────────

/**
 * Fetch current OWGR rankings from ESPN's public API.
 * No API key required.
 */
export async function fetchWorldRankings(): Promise<ESPNRankingEntry[]> {
  const res = await fetch(ESPN_RANKINGS_URL, {
    cache: "force-cache",
  });

  if (!res.ok) {
    throw new Error(`ESPN rankings fetch failed: ${res.status} ${res.statusText}`);
  }

  const data: ESPNRankingsResponse = await res.json();

  if (!data?.rankings?.length) {
    throw new Error('ESPN rankings response was empty or malformed');
  }

  return data.rankings;
}

// ── Sync to database ─────────────────────────────────────────

/**
 * Fetch rankings from ESPN and upsert into the golfers table.
 * Matches players by ESPN ID first, then by name as fallback.
 * Inserts new players if not found.
 */
export async function syncRankingsToDatabase(): Promise<{
  updated: number;
  inserted: number;
  errors: number;
}> {
  const rankings = await fetchWorldRankings();

  let updated  = 0;
  let inserted = 0;
  let errors   = 0;

  for (const entry of rankings) {
    const { current: owgrRank, athlete } = entry;
    const espnId  = athlete.id;
    const name    = athlete.displayName;
    const country = athlete.flag?.alt ?? null;
    const headshot = athlete.headshot?.href ?? null;

    try {
      // 1. Try to find by ESPN ID (most reliable)
      const byId = await db.selectFrom('golfers')
        .select('id')
        .where('espn_id', '=', espnId)
        .executeTakeFirst();

      if (byId) {
        // Update existing record
        await db.updateTable('golfers')
          .set({
            owgr_rank:    owgrRank,
            country,
            headshot_url: headshot,
            updated_at:   new Date().toISOString(),
          })
          .where('id', '=', byId.id)
          .execute();
        updated++;
        continue;
      }

      // 2. Fallback: match by name (handles players added via score sync
      //    before rankings sync ran).
      const byName = await db.selectFrom('golfers')
        .select('id')
        .where('name', 'ilike', name)
        .executeTakeFirst();

      if (byName) {
        await db.updateTable('golfers')
          .set({
            espn_id:      espnId,   // backfill ESPN ID
            owgr_rank:    owgrRank,
            country,
            headshot_url: headshot,
            updated_at:   new Date().toISOString(),
          })
          .where('id', '=', byName.id)
          .execute();
        updated++;
        continue;
      }

      // 3. New player — insert fresh row
      try {
        await db.insertInto('golfers')
          .values({
            espn_id:      espnId,
            name,
            owgr_rank:    owgrRank,
            country,
            headshot_url: headshot,
          })
          .execute();
        inserted++;
      } catch (insertErr) {
        console.error(`Insert failed for ${name}:`, insertErr);
        errors++;
      }

    } catch (err) {
      console.error(`Rankings sync error for ${name}:`, err);
      errors++;
    }
  }

  return { updated, inserted, errors };
}

// ── Dark horse helpers ───────────────────────────────────────

/** Players ranked 25 or beyond are considered dark horses. */
export const DARK_HORSE_CUTOFF = 25;

export function isDarkHorse(owgrRank: number | null): boolean {
  if (owgrRank === null) return true; // Unranked counts as dark horse
  return owgrRank >= DARK_HORSE_CUTOFF;
}
