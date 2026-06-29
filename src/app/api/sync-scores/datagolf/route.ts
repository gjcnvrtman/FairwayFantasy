// ============================================================
// /api/sync-scores/datagolf — weekly Datagolf pull.
//
// Triggered by fairway-datagolf.timer on Mondays 06:30 (30 min after
// the rankings sync so any new golfers from ESPN's schedule land
// first, giving the matcher more candidates).
//
// Steps (partial-success — each step's failure is captured but does
// not abort the others):
//
//   1. Get-player-list  → upsert golfers.datagolf_id where the
//                         existing row matches by name and currently
//                         has NULL datagolf_id. This back-fills the
//                         link incrementally without touching rows
//                         that already have it set.
//
//   2. Pre-tournament   → fetch predictions for the upcoming PGA
//      predictions       tournament (latest 'upcoming' or 'active'
//                         row in tournaments). UPSERT into
//                         datagolf_tournament_predictions via the
//                         UNIQUE (tournament_id, datagolf_player_id)
//                         constraint.
//
// Auth: Bearer ${CRON_SECRET}, same pattern as /api/sync-scores/rankings.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  getPlayerList, getPreTournamentPredictions,
  pct, dgNameToCanonical,
  type DGPreTournamentRow,
} from '@/lib/datagolf';

// Normalize golfer names for fuzzy-matching against the local DB.
// Mirrors scripts/import-stats.ts so behavior stays aligned.
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/\b(jr|sr|iii|ii|iv)\.?\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── 1. Player list → back-fill datagolf_id ──────────────────
  let playersFetched = 0;
  let playersLinked = 0;
  let playerListError: string | null = null;
  try {
    const list = await getPlayerList();
    playersFetched = list.length;

    // Build a normalized-name index over local golfers that DON'T
    // already have a datagolf_id set — only those rows are eligible
    // for back-fill. Rows that have it stay untouched.
    const unlinked = await db.selectFrom('golfers')
      .select(['id', 'name'])
      .where('datagolf_id', 'is', null)
      .execute();
    const byNorm = new Map<string, { id: string; name: string }>();
    for (const g of unlinked) byNorm.set(normalize(g.name), g);

    // Loop through Datagolf players, only link on EXACT normalized
    // match — fuzzy matches at the cron path would silently mis-link
    // similar names (Patrick Reed vs Patrick Rodgers). Reserve fuzzy
    // for the interactive CLI path.
    for (const p of list) {
      const canonical = dgNameToCanonical(p.player_name);
      const norm = normalize(canonical);
      const local = byNorm.get(norm);
      if (local) {
        await db.updateTable('golfers')
          .set({ datagolf_id: p.dg_id })
          .where('id', '=', local.id)
          .where('datagolf_id', 'is', null)
          .execute();
        playersLinked++;
      }
    }
  } catch (err) {
    playerListError = err instanceof Error ? err.message : String(err);
    console.error('Datagolf player-list sync failed:', err);
  }

  // ── 2. Pre-tournament predictions ───────────────────────────
  let preTournamentName: string | null = null;
  let preTournamentRows = 0;
  let preTournamentUpserted = 0;
  let preTournamentUnmatched = 0;
  let preTournamentError: string | null = null;

  // Find the tournament we should pull predictions for: the next
  // upcoming PGA event whose pick_deadline is in the future, or the
  // currently-active event if no upcoming exists.
  let targetTournamentId: string | null = null;
  try {
    const nowIso = new Date().toISOString();
    const upcoming = await db.selectFrom('tournaments')
      .select(['id'])
      .where('start_date', '>=', nowIso)
      .where('type', 'in', ['regular', 'major'])
      .orderBy('start_date', 'asc')
      .limit(1)
      .executeTakeFirst();
    if (upcoming) {
      targetTournamentId = upcoming.id;
    } else {
      // Fallback to the currently-active event.
      const active = await db.selectFrom('tournaments')
        .select(['id'])
        .where('status', '=', 'active')
        .orderBy('start_date', 'desc')
        .limit(1)
        .executeTakeFirst();
      targetTournamentId = active?.id ?? null;
    }
  } catch (err) {
    preTournamentError = `tournament lookup failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (targetTournamentId && !preTournamentError) {
    try {
      const preds = await getPreTournamentPredictions('pga');
      preTournamentName = preds.event_name;
      // Prefer baseline_history_fit when present (incorporates the
      // venue history component of the model); fall back to baseline.
      const rows: DGPreTournamentRow[] =
        preds.baseline_history_fit ?? preds.baseline ?? [];
      preTournamentRows = rows.length;

      // Index local golfers by datagolf_id for fast lookup.
      const dgLinked = await db.selectFrom('golfers')
        .select(['id', 'datagolf_id'])
        .where('datagolf_id', 'is not', null)
        .execute();
      const byDgId = new Map<number, string>();
      for (const g of dgLinked) {
        if (g.datagolf_id != null) byDgId.set(g.datagolf_id, g.id);
      }

      for (const row of rows) {
        const golferId = byDgId.get(row.dg_id) ?? null;
        if (!golferId) preTournamentUnmatched++;

        await db.insertInto('datagolf_tournament_predictions')
          .values({
            tournament_id:        targetTournamentId,
            golfer_id:            golferId,
            datagolf_player_id:   row.dg_id,
            player_name_raw:      row.player_name,
            win_prob:             stringOrNull(pct(row.win)),
            top_5_prob:           stringOrNull(pct(row.top_5)),
            top_10_prob:          stringOrNull(pct(row.top_10)),
            top_20_prob:          stringOrNull(pct(row.top_20)),
            make_cut_prob:        stringOrNull(pct(row.make_cut)),
            expected_finish:      stringOrNull(toNum(row.expected_finish)),
            raw_json:             row,
          })
          .onConflict(oc => oc.columns(['tournament_id', 'datagolf_player_id']).doUpdateSet(eb => ({
            golfer_id:        eb.ref('excluded.golfer_id'),
            player_name_raw:  eb.ref('excluded.player_name_raw'),
            pulled_at:        new Date().toISOString(),
            win_prob:         eb.ref('excluded.win_prob'),
            top_5_prob:       eb.ref('excluded.top_5_prob'),
            top_10_prob:      eb.ref('excluded.top_10_prob'),
            top_20_prob:      eb.ref('excluded.top_20_prob'),
            make_cut_prob:    eb.ref('excluded.make_cut_prob'),
            expected_finish:  eb.ref('excluded.expected_finish'),
            raw_json:         eb.ref('excluded.raw_json'),
          })))
          .execute();
        preTournamentUpserted++;
      }
    } catch (err) {
      preTournamentError = err instanceof Error ? err.message : String(err);
      console.error('Datagolf pre-tournament sync failed:', err);
    }
  } else if (!preTournamentError) {
    preTournamentError = 'no upcoming or active tournament found';
  }

  const ok = !playerListError && !preTournamentError;
  return NextResponse.json({
    ok,
    playerList: {
      fetched: playersFetched,
      newlyLinked: playersLinked,
      error: playerListError,
    },
    preTournament: {
      tournament_id: targetTournamentId,
      event_name: preTournamentName,
      rows: preTournamentRows,
      upserted: preTournamentUpserted,
      unmatched: preTournamentUnmatched,
      error: preTournamentError,
    },
  }, { status: ok ? 200 : 207 });
}

// Pg returns NUMERIC columns as strings (precision-preserving). When
// writing through Kysely we mirror that by passing strings — null
// stays null.
function stringOrNull(v: number | null): string | null {
  return v == null ? null : v.toString();
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
