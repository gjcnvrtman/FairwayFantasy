// ============================================================
// SCORE SYNC — shared engine
//
// Used by two routes:
//   /api/sync-scores       (Bearer CRON_SECRET) — systemd timer
//   /api/admin/sync-scores (commissioner session) — admin "Sync Now"
//
// Extracted into a module so the admin route doesn't have to bake
// CRON_SECRET into the client bundle (P1 #4.1 was that the panel
// invoked the cron endpoint with `Bearer NEXT_PUBLIC_CRON_SECRET`,
// which leaked the secret to anyone who downloaded the JS bundle).
// ============================================================

import { db } from './db';
import { fetchLiveLeaderboard, parseESPNScore } from './espn';
import { applyFantasyRules, computeLeagueResults } from './scoring';
import type { Score, Pick } from '@/types';

export interface SyncResult {
  tournament?:   string;
  competitors?:  number;
  currentRound?: number;
  status?:       string;
  skipped?:      boolean;
  error?:        string;
}

export interface SyncSummary {
  ok:        boolean;
  message?:  string;
  results?:  SyncResult[];
  error?:    string;
  /** Did we touch any rows? Useful for "no-op" UI feedback. */
  touched?:  number;
}

/**
 * Top-level entry point. Looks up active+cut_made tournaments and
 * pulls fresh scores from ESPN for each, recomputing fantasy results
 * + season standings as it goes.
 */
export async function runScoreSync(): Promise<SyncSummary> {
  try {
    const activeTournaments = await db.selectFrom('tournaments')
      .selectAll()
      .where('status', 'in', ['active', 'cut_made'])
      .execute();

    if (activeTournaments.length === 0) {
      return { ok: true, message: 'No active tournaments', touched: 0, results: [] };
    }

    const results: SyncResult[] = [];
    for (const t of activeTournaments) {
      results.push(await syncTournament(t));
    }
    return { ok: true, results, touched: results.length };
  } catch (err) {
    console.error('Sync error:', err);
    return { ok: false, error: String(err) };
  }
}

async function syncTournament(tournament: {
  id:             string;
  espn_event_id:  string;
  name:           string;
  cut_score:      number | null;
}): Promise<SyncResult> {
  const { espn_event_id, id, cut_score } = tournament;
  const { competitors, cutScore: espnCut, status, currentRound } =
    await fetchLiveLeaderboard(espn_event_id);

  if (!competitors.length) return { skipped: true };

  const newStatus = status.toLowerCase().includes('final') ? 'complete'
    : espnCut !== null ? 'cut_made' : 'active';

  await db.updateTable('tournaments')
    .set({ status: newStatus, cut_score: espnCut ?? cut_score })
    .where('id', '=', id)
    .execute();

  const effectiveCut = espnCut ?? cut_score;
  // Bug #5.1: only apply the made-cut cap once the cut has been
  // officially made (status `cut_made` or `complete`). During Round 1-2
  // active play, scores are returned as-is.
  const cutMade = newStatus !== 'active';
  const scoreUpdates: Array<{
    tournament_id:  string;
    golfer_id:      string;
    espn_golfer_id: string;
    round_1: number | null; round_2: number | null;
    round_3: number | null; round_4: number | null;
    score_to_par:   number;
    position:       string;
    status:         Score['status'];
    fantasy_score:  number | null;
    last_synced:    string;
  }> = [];

  for (const c of competitors) {
    // Find or create the golfer row.
    let golfer = await db.selectFrom('golfers')
      .select('id')
      .where('espn_id', '=', c.id)
      .executeTakeFirst();

    if (!golfer) {
      golfer = await db.insertInto('golfers')
        .values({
          espn_id:      c.id,
          name:         c.displayName,
          headshot_url: c.headshot?.href ?? null,
        })
        .returning('id')
        .executeTakeFirst();
    }
    if (!golfer) continue;

    const espnStatus = c.status?.type?.name ?? 'active';
    const scoreStr   = c.score?.displayValue ?? 'E';
    const { fantasyScore, status: mappedStatus } = applyFantasyRules({
      scoreToParRaw: scoreStr, espnStatus, cutScore: effectiveCut, cutMade,
    });

    const rounds = c.linescores?.map(ls => ls.value) ?? [];
    scoreUpdates.push({
      tournament_id:  id,
      golfer_id:      golfer.id,
      espn_golfer_id: c.id,
      round_1: rounds[0] ?? null, round_2: rounds[1] ?? null,
      round_3: rounds[2] ?? null, round_4: rounds[3] ?? null,
      score_to_par:   parseESPNScore(scoreStr),
      position:       String(c.sortOrder ?? ''),
      status:         mappedStatus,
      fantasy_score:  fantasyScore,
      last_synced:    new Date().toISOString(),
    });
  }

  if (scoreUpdates.length) {
    // Upsert all scores in one statement using ON CONFLICT.
    await db.insertInto('scores')
      .values(scoreUpdates)
      .onConflict(oc => oc
        .columns(['tournament_id', 'golfer_id'])
        .doUpdateSet(eb => ({
          espn_golfer_id: eb.ref('excluded.espn_golfer_id'),
          round_1:        eb.ref('excluded.round_1'),
          round_2:        eb.ref('excluded.round_2'),
          round_3:        eb.ref('excluded.round_3'),
          round_4:        eb.ref('excluded.round_4'),
          score_to_par:   eb.ref('excluded.score_to_par'),
          position:       eb.ref('excluded.position'),
          status:         eb.ref('excluded.status'),
          fantasy_score:  eb.ref('excluded.fantasy_score'),
          last_synced:    eb.ref('excluded.last_synced'),
        })),
      )
      .execute();
  }

  await recomputeResults(id);
  return {
    tournament:   tournament.name,
    competitors:  competitors.length,
    currentRound,
    status:       newStatus,
  };
}

async function recomputeResults(tournamentId: string) {
  const allPicks = await db.selectFrom('picks')
    .selectAll()
    .where('tournament_id', '=', tournamentId)
    .execute();
  if (allPicks.length === 0) return;

  const allScores = await db.selectFrom('scores')
    .selectAll()
    .where('tournament_id', '=', tournamentId)
    .execute();
  const scoreMap = new Map<string, Score>();
  for (const s of allScores) scoreMap.set(s.golfer_id, s as Score);

  const byLeague = new Map<string, Pick[]>();
  for (const p of allPicks as Pick[]) {
    if (!byLeague.has(p.league_id)) byLeague.set(p.league_id, []);
    byLeague.get(p.league_id)!.push(p);
  }

  for (const [, picks] of byLeague) {
    const results = computeLeagueResults(picks, scoreMap);
    for (const r of results) {
      await db.insertInto('fantasy_results')
        .values({ ...r, updated_at: new Date().toISOString() })
        .onConflict(oc => oc
          .columns(['league_id', 'tournament_id', 'user_id'])
          .doUpdateSet(eb => ({
            golfer_1_score:   eb.ref('excluded.golfer_1_score'),
            golfer_2_score:   eb.ref('excluded.golfer_2_score'),
            golfer_3_score:   eb.ref('excluded.golfer_3_score'),
            golfer_4_score:   eb.ref('excluded.golfer_4_score'),
            counting_golfers: eb.ref('excluded.counting_golfers'),
            total_score:      eb.ref('excluded.total_score'),
            rank:             eb.ref('excluded.rank'),
            updated_at:       eb.ref('excluded.updated_at'),
          })),
        )
        .execute();
    }
  }

  // Update season standings
  const t = await db.selectFrom('tournaments')
    .select('season')
    .where('id', '=', tournamentId)
    .executeTakeFirst();
  if (!t) return;

  const results = await db.selectFrom('fantasy_results')
    .select(['league_id', 'user_id', 'total_score', 'rank'])
    .execute();

  // NOTE: bug #3.3 — this aggregator pulls EVERY fantasy_results row
  // across ALL tournaments and seasons, then folds them into one
  // standings row per (league, user). For correctness we should
  // filter by season=t.season here (joined via tournaments) — left
  // intact during P2 since the bug is tracked separately in TODO P0.
  const map = new Map<string, {
    league_id: string; user_id: string;
    total: number; count: number; best: number;
  }>();
  for (const r of results) {
    const k = `${r.league_id}:${r.user_id}`;
    const e = map.get(k);
    if (e) {
      e.total += r.total_score ?? 0;
      e.count++;
      if (r.rank) e.best = Math.min(e.best, r.rank);
    } else {
      map.set(k, {
        league_id: r.league_id, user_id: r.user_id,
        total: r.total_score ?? 0, count: 1,
        best: r.rank ?? 999,                     // bug #3.4
      });
    }
  }

  for (const s of map.values()) {
    await db.insertInto('season_standings')
      .values({
        league_id:          s.league_id,
        user_id:            s.user_id,
        season:             t.season,
        total_score:        s.total,
        tournaments_played: s.count,
        best_finish:        s.best,
        updated_at:         new Date().toISOString(),
      })
      .onConflict(oc => oc
        .columns(['league_id', 'user_id', 'season'])
        .doUpdateSet(eb => ({
          total_score:        eb.ref('excluded.total_score'),
          tournaments_played: eb.ref('excluded.tournaments_played'),
          best_finish:        eb.ref('excluded.best_finish'),
          updated_at:         eb.ref('excluded.updated_at'),
        })),
      )
      .execute();
  }
}
