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
    // Tournaments that should be syncing right now:
    //   - start_date has passed (tournament has begun)
    //   - end_date hasn't passed by more than 24h (still relevant)
    //   - status isn't already `complete` (no point re-syncing finished events)
    //
    // The previous version filtered to `status in ('active', 'cut_made')`
    // which created a chicken-and-egg bug: rankings sync inserts new
    // tournaments with default status `upcoming`, but nothing flipped
    // them to `active` when their start_date arrived. So timers fired
    // dutifully but found nothing to do during real tournaments.
    // Now any tournament whose start_date has passed gets a sync;
    // syncTournament() inside fetches live data from ESPN and updates
    // the status field appropriately.
    const now        = new Date();
    const oneDayAgo  = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const activeTournaments = await db.selectFrom('tournaments')
      .selectAll()
      .where('start_date', '<=', now.toISOString())
      .where('end_date',   '>=', oneDayAgo.toISOString())
      .where('status', '!=', 'complete')
      .execute();

    if (activeTournaments.length === 0) {
      return { ok: true, message: 'No tournaments in active window', touched: 0, results: [] };
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

  // Cut-detection inference (added 2026-05-17).
  //
  // ESPN's scoreboard fallback (used whenever /pga/leaderboard 404s,
  // currently the case for the 2026-05 PGA Championship and most
  // recent events) returns:
  //   cutScore: null
  //   per-golfer status: nothing
  // …so the old "espnCut !== null → cut_made" trigger never fires.
  // Until 2026-05-17 this meant tournament.status got stuck at
  // 'active' through all four rounds AND no golfer was ever
  // classified missed_cut, breaking the new missed-cut scoring rule.
  //
  // Two data-driven signals replace the cutScore dependency:
  //
  //   1. cutHasBeenMade  ⇐  currentRound >= 3
  //      Once ESPN reports we're in Round 3 or later, the cut has
  //      been made by definition. Flips tournament.status to cut_made.
  //
  //   2. inferred per-golfer missed_cut  ⇐  linescores.length < 3
  //      AND R1+R2 are both present. A golfer who finished 36 holes
  //      but didn't appear in R3 missed the cut. Applied only when
  //      ESPN's per-golfer status was the default 'active' (i.e.
  //      scoreboard fallback) — we trust an explicit WD/DQ/MC from
  //      the leaderboard endpoint when present.
  //
  // We also derive an inferred cut line from cut-survivor totals so
  // tournament.cut_score can still be populated for the made-cut
  // cap in applyFantasyRules. Strictly informational under the new
  // top-3-of-non-MC rule, but it keeps the field meaningful.
  const cutHasBeenMade = currentRound >= 3 || espnCut !== null;

  let effectiveCut: number | null = espnCut ?? cut_score;
  if (cutHasBeenMade && effectiveCut === null) {
    const survivorTotals: number[] = [];
    for (const c of competitors) {
      const ls = c.linescores ?? [];
      if (ls.length >= 3) {
        const r1 = ls[0]?.value, r2 = ls[1]?.value;
        if (typeof r1 === 'number' && typeof r2 === 'number') {
          survivorTotals.push(r1 + r2);
        }
      }
    }
    if (survivorTotals.length > 0) {
      // Cut line = worst 36-hole total that still made the cut.
      effectiveCut = Math.max(...survivorTotals);
    }
  }

  const newStatus = status.toLowerCase().includes('final') ? 'complete'
    : cutHasBeenMade ? 'cut_made' : 'active';

  await db.updateTable('tournaments')
    .set({ status: newStatus, cut_score: effectiveCut ?? cut_score })
    .where('id', '=', id)
    .execute();

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

    let espnStatus  = c.status?.type?.name ?? 'active';
    const scoreStr  = c.score?.displayValue ?? 'E';
    const rounds    = c.linescores?.map(ls => ls.value) ?? [];

    // Cut-day backstop (revised 2026-05-17).
    //
    // ESPN's /pga/scoreboard fallback doesn't carry a per-golfer
    // status, so normalizeScoreboardCompetitor defaults every golfer
    // to 'active'. We need a way to flip post-cut golfers to
    // missed_cut without relying on a cut-score comparison (since
    // ESPN often doesn't return cutScore either).
    //
    // The cleanest signal is the LENGTH of the linescores array:
    // ESPN includes R3 entries only for golfers who continued past
    // the cut, regardless of whether they've actually played R3 yet
    // (the entry will exist with value=0 and displayValue='-' for
    // not-yet-played). A golfer who finished 36 holes (both R1 and
    // R2 present) but has fewer than 3 linescores entries didn't
    // continue → missed the cut.
    //
    // Applied only when ESPN status was the default 'active' so we
    // don't override an explicit WD / DQ / MC from the leaderboard
    // endpoint when it is reachable. Also requires the cut to have
    // been made (avoids classifying mid-R2 WDs as missed_cut).
    if (cutMade && espnStatus === 'active') {
      const r1 = rounds[0], r2 = rounds[1];
      const continuedPastCut = rounds.length >= 3;
      if (!continuedPastCut && r1 != null && r2 != null) {
        espnStatus = 'missed_cut';
      }
    }

    const { fantasyScore, status: mappedStatus } = applyFantasyRules({
      scoreToParRaw: scoreStr, espnStatus, cutScore: effectiveCut, cutMade,
    });
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

  // Update season standings — scoped to the tournament's own season
  // (bug #3.3 fix). Previously selectFrom('fantasy_results') with no
  // filter pulled every row across every tournament and season, so
  // standings accumulated forever. Join via tournaments and filter on
  // season=t.season to get just this season's contributions.
  const t = await db.selectFrom('tournaments')
    .select('season')
    .where('id', '=', tournamentId)
    .executeTakeFirst();
  if (!t) return;

  const results = await db.selectFrom('fantasy_results')
    .innerJoin('tournaments', 'tournaments.id', 'fantasy_results.tournament_id')
    .select([
      'fantasy_results.league_id',
      'fantasy_results.user_id',
      'fantasy_results.total_score',
      'fantasy_results.rank',
    ])
    .where('tournaments.season', '=', t.season)
    .execute();

  // best_finish starts as null instead of 999 sentinel (bug #3.4):
  // the old code initialized to 999 when r.rank was null, then only
  // updated when a later row had a rank — so a user whose first row
  // had null rank kept best_finish=999 forever.
  const map = new Map<string, {
    league_id: string; user_id: string;
    total: number; count: number; best: number | null;
  }>();
  for (const r of results) {
    const k = `${r.league_id}:${r.user_id}`;
    const e = map.get(k);
    if (e) {
      e.total += r.total_score ?? 0;
      e.count++;
      if (r.rank != null) {
        e.best = e.best == null ? r.rank : Math.min(e.best, r.rank);
      }
    } else {
      map.set(k, {
        league_id: r.league_id, user_id: r.user_id,
        total: r.total_score ?? 0, count: 1,
        best: r.rank ?? null,
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
