// ============================================================
// WORLD RANKINGS CLIENT — powered by ESPN (free, no API key)
// Replaces DataGolf — no Scratch Plus membership needed.
//
// ESPN endpoint:
//   https://site.web.api.espn.com/apis/site/v2/sports/golf/pga/rankings
//
// Called once per week by the /api/sync-scores/rankings cron job.
// ============================================================

import { supabaseAdmin } from './supabase';

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
      const { data: byId } = await supabaseAdmin
        .from('golfers')
        .select('id')
        .eq('espn_id', espnId)
        .single();

      if (byId) {
        // Update existing record
        await supabaseAdmin
          .from('golfers')
          .update({
            owgr_rank:    owgrRank,
            country,
            headshot_url: headshot,
            updated_at:   new Date().toISOString(),
          })
          .eq('id', byId.id);
        updated++;
        continue;
      }

      // 2. Fallback: match by name (handles players added via score sync
      //    before rankings sync ran)
      const { data: byName } = await supabaseAdmin
        .from('golfers')
        .select('id')
        .ilike('name', name)
        .single();

      if (byName) {
        await supabaseAdmin
          .from('golfers')
          .update({
            espn_id:      espnId,   // backfill ESPN ID
            owgr_rank:    owgrRank,
            country,
            headshot_url: headshot,
            updated_at:   new Date().toISOString(),
          })
          .eq('id', byName.id);
        updated++;
        continue;
      }

      // 3. New player — insert fresh row
      const { error } = await supabaseAdmin
        .from('golfers')
        .insert({
          espn_id:      espnId,
          name,
          owgr_rank:    owgrRank,
          country,
          headshot_url: headshot,
        });

      if (error) {
        console.error(`Insert failed for ${name}:`, error.message);
        errors++;
      } else {
        inserted++;
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
