#!/usr/bin/env tsx
/* ============================================================
 * SEED GOLFERS — workaround for ESPN's broken /pga/rankings endpoint.
 *
 * As of May 2026 ESPN's rankings endpoint returns 500 with
 *   {"code":2404,"detail":"http error: not found"}
 * at every URL variant we tried. Until we find a working ranking
 * source (or ESPN restores it), use this script to populate the
 * golfers table:
 *
 *   1. `--from-event <espnEventId>` pulls the player field for
 *      that tournament from ESPN (the field endpoint still works)
 *      and upserts every player into the `golfers` table with
 *      NULL rank. Picks list now has names + headshots, but every
 *      player counts as "dark horse" via the unranked-is-DH rule.
 *
 *   2. `--apply-ranks` reads `data/owgr-top.json` and overlays
 *      OWGR top-24 ranks onto matching rows in `golfers` (matched
 *      by name). After this runs, top-tier slots in the picks UI
 *      have something to select.
 *
 *   3. Both at once: pass both flags. Common case.
 *
 * USAGE
 *   # Step 1 — populate golfers from the next upcoming tournament:
 *   DATABASE_URL='postgresql://...' \
 *     npx tsx scripts/seed-golfers.ts --from-event 401812345
 *
 *   # Step 2 — apply ranks from data/owgr-top.json:
 *   DATABASE_URL='postgresql://...' \
 *     npx tsx scripts/seed-golfers.ts --apply-ranks
 *
 *   # Both:
 *   DATABASE_URL='postgresql://...' \
 *     npx tsx scripts/seed-golfers.ts --from-event 401812345 --apply-ranks
 *
 * To find the event ID: the rankings sync (now partial-success)
 * populates the `tournaments` table. Pick any upcoming one:
 *   psql "$DATABASE_URL" -c "
 *     SELECT espn_event_id, name, start_date FROM tournaments
 *     WHERE status = 'upcoming' ORDER BY start_date LIMIT 5;"
 * ============================================================ */

import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Args ────────────────────────────────────────────────────
const args = process.argv.slice(2);
const fromEventIdx = args.indexOf('--from-event');
const fromEventId  = fromEventIdx >= 0 ? args[fromEventIdx + 1] : null;
const applyRanks   = args.includes('--apply-ranks');

if (!fromEventId && !applyRanks) {
  console.error('Usage: seed-golfers.ts [--from-event <espnEventId>] [--apply-ranks]');
  console.error('Pass at least one. See header comment for details.');
  process.exit(2);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL env var is required.');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });

// ── Step 1: pull field from ESPN, upsert golfers ────────────

async function seedFromEvent(eventId: string): Promise<number> {
  console.log(`\n▸ Pulling player field for event ${eventId} from ESPN...`);

  // Try the leaderboard endpoint first — populated once the tournament
  // starts. For UPCOMING events ESPN returns 404 there, so we fall
  // back to the scoreboard endpoint (which has event metadata for
  // future tournaments). Same JSON shape; same parser handles both.
  const candidates = [
    `https://site.web.api.espn.com/apis/site/v2/sports/golf/pga/leaderboard?event=${eventId}`,
    `https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?event=${eventId}`,
  ];

  let data: {
    events?: Array<{
      competitions?: Array<{
        competitors?: Array<{
          id: string;
          displayName: string;
          headshot?: { href: string };
        }>;
      }>;
    }>;
  } | null = null;

  for (const url of candidates) {
    const res = await fetch(url, { cache: 'no-store' as RequestCache });
    if (res.ok) {
      data = await res.json();
      console.log(`  ✓ fetched from ${url.includes('/scoreboard') ? 'scoreboard' : 'leaderboard'} endpoint`);
      break;
    }
    console.log(`  ✗ ${url.split('/').slice(-1)[0]}: HTTP ${res.status}`);
  }

  if (!data) {
    throw new Error(`ESPN field fetch failed at every candidate endpoint for event ${eventId}`);
  }

  const competitors = data.events?.[0]?.competitions?.[0]?.competitors ?? [];
  if (competitors.length === 0) {
    throw new Error(
      `No competitors in event ${eventId} — ESPN may not have published the ` +
      `field yet (typically 1-2 days before tee time). Try a recently-completed ` +
      `event whose leaderboard is populated.`,
    );
  }
  console.log(`  found ${competitors.length} players`);

  let inserted = 0;
  let updated  = 0;
  for (const c of competitors) {
    const r = await pool.query<{ created: boolean }>(
      `INSERT INTO golfers (espn_id, name, headshot_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (espn_id) DO UPDATE SET
         name         = EXCLUDED.name,
         headshot_url = COALESCE(EXCLUDED.headshot_url, golfers.headshot_url),
         updated_at   = NOW()
       RETURNING (xmax = 0) AS created`,
      [c.id, c.displayName, c.headshot?.href ?? null],
    );
    if (r.rows[0].created) inserted++;
    else                   updated++;
  }
  console.log(`  ✓ inserted ${inserted}, updated ${updated}`);
  return competitors.length;
}

// ── Step 2: apply OWGR ranks from JSON ──────────────────────

async function applyRanksFromFile(): Promise<void> {
  // Resolve data/owgr-top.json relative to this script (works regardless of cwd)
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, '..', 'data', 'owgr-top.json');
  console.log(`\n▸ Applying ranks from ${path}...`);
  const raw  = readFileSync(path, 'utf8');
  const json = JSON.parse(raw) as { rankings: Array<{ name: string; rank: number }> };

  if (!Array.isArray(json.rankings) || json.rankings.length === 0) {
    throw new Error('owgr-top.json has no `rankings` array');
  }

  let matched   = 0;
  const missing: string[] = [];
  for (const { name, rank } of json.rankings) {
    // Match by exact name first; fall back to ILIKE for case/spacing diffs.
    let r = await pool.query<{ id: string }>(
      `UPDATE golfers SET owgr_rank = $1, updated_at = NOW()
       WHERE name = $2 RETURNING id`,
      [rank, name],
    );
    if (r.rowCount === 0) {
      r = await pool.query<{ id: string }>(
        `UPDATE golfers SET owgr_rank = $1, updated_at = NOW()
         WHERE name ILIKE $2 RETURNING id`,
        [rank, name],
      );
    }
    if (r.rowCount && r.rowCount > 0) {
      matched++;
      console.log(`  ✓ #${rank.toString().padStart(2)}: ${name}`);
    } else {
      missing.push(`#${rank}: ${name}`);
    }
  }
  console.log(`\n  matched ${matched}/${json.rankings.length}`);
  if (missing.length > 0) {
    console.log(`  not found in golfers table (typos or not in this tournament's field):`);
    for (const m of missing) console.log(`    - ${m}`);
    console.log(`  Either fix spelling in data/owgr-top.json, or run --from-event`);
    console.log(`  on a different tournament whose field includes them.`);
  }
}

// ── Run ─────────────────────────────────────────────────────

async function main() {
  if (fromEventId) {
    await seedFromEvent(fromEventId);
  }
  if (applyRanks) {
    await applyRanksFromFile();
  }

  // Quick summary of the current state
  const r = await pool.query(`
    SELECT
      COUNT(*)::int                                   AS total,
      COUNT(*) FILTER (WHERE owgr_rank IS NOT NULL)::int AS ranked,
      COUNT(*) FILTER (WHERE owgr_rank <= 24)::int        AS top_tier
    FROM golfers`);
  const { total, ranked, top_tier } = r.rows[0];
  console.log(`\n=== golfers table summary ===`);
  console.log(`  total:    ${total}`);
  console.log(`  ranked:   ${ranked}`);
  console.log(`  top tier: ${top_tier}  (need ≥ 24 for picks slots 1-2 to be selectable)`);

  if (top_tier < 24) {
    console.log(`\n  ⚠ Only ${top_tier} top-tier golfers — picks UI may not have enough.`);
    console.log(`    Either run --apply-ranks (if you didn't), or update`);
    console.log(`    data/owgr-top.json with names that match this tournament's field.`);
  } else {
    console.log(`\n  ✓ Picks UI has enough top-tier golfers to function.`);
  }
}

main()
  .catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
