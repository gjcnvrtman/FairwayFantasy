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

import { supabaseAdmin } from './supabase';
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
    const { data: activeTournaments } = await supabaseAdmin
      .from('tournaments').select('*').in('status', ['active', 'cut_made']);

    if (!activeTournaments?.length) {
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

async function syncTournament(tournament: any): Promise<SyncResult> {
  const { espn_event_id, id, cut_score } = tournament;
  const { competitors, cutScore: espnCut, status, currentRound } =
    await fetchLiveLeaderboard(espn_event_id);

  if (!competitors.length) return { skipped: true };

  const newStatus = status.toLowerCase().includes('final') ? 'complete'
    : espnCut !== null ? 'cut_made' : 'active';

  await supabaseAdmin.from('tournaments')
    .update({ status: newStatus, cut_score: espnCut ?? cut_score }).eq('id', id);

  const effectiveCut = espnCut ?? cut_score;
  // Bug #5.1: only apply the made-cut cap once the cut has been
  // officially made (status `cut_made` or `complete`). During Round 1-2
  // active play, scores are returned as-is.
  const cutMade = newStatus !== 'active';
  const scoreUpdates: any[] = [];

  for (const c of competitors) {
    let { data: golfer } = await supabaseAdmin
      .from('golfers').select('id').eq('espn_id', c.id).single();

    if (!golfer) {
      const { data: ng } = await supabaseAdmin.from('golfers')
        .insert({ espn_id: c.id, name: c.displayName, headshot_url: c.headshot?.href ?? null })
        .select('id').single();
      golfer = ng;
    }
    if (!golfer) continue;

    const espnStatus = c.status?.type?.name ?? 'active';
    const scoreStr   = c.score?.displayValue ?? 'E';
    const { fantasyScore, status: mappedStatus } = applyFantasyRules({
      scoreToParRaw: scoreStr, espnStatus, cutScore: effectiveCut, cutMade,
    });

    const rounds = c.linescores?.map((ls: any) => ls.value) ?? [];
    scoreUpdates.push({
      tournament_id: id, golfer_id: golfer.id, espn_golfer_id: c.id,
      round_1: rounds[0] ?? null, round_2: rounds[1] ?? null,
      round_3: rounds[2] ?? null, round_4: rounds[3] ?? null,
      score_to_par: parseESPNScore(scoreStr),
      position: String(c.sortOrder ?? ''),
      status: mappedStatus, fantasy_score: fantasyScore,
      last_synced: new Date().toISOString(),
    });
  }

  if (scoreUpdates.length) {
    await supabaseAdmin.from('scores')
      .upsert(scoreUpdates, { onConflict: 'tournament_id,golfer_id' });
  }

  await recomputeResults(id);
  return { tournament: tournament.name, competitors: competitors.length, currentRound, status: newStatus };
}

async function recomputeResults(tournamentId: string) {
  const { data: allPicks } = await supabaseAdmin.from('picks').select('*').eq('tournament_id', tournamentId);
  if (!allPicks?.length) return;

  const { data: allScores } = await supabaseAdmin.from('scores').select('*').eq('tournament_id', tournamentId);
  const scoreMap = new Map<string, Score>();
  for (const s of allScores ?? []) scoreMap.set(s.golfer_id, s as Score);

  const byLeague = new Map<string, Pick[]>();
  for (const p of allPicks as Pick[]) {
    if (!byLeague.has(p.league_id)) byLeague.set(p.league_id, []);
    byLeague.get(p.league_id)!.push(p);
  }

  for (const [, picks] of byLeague) {
    const results = computeLeagueResults(picks, scoreMap);
    for (const r of results) {
      await supabaseAdmin.from('fantasy_results')
        .upsert({ ...r, updated_at: new Date().toISOString() },
          { onConflict: 'league_id,tournament_id,user_id' });
    }
  }

  // Update season standings
  const { data: t } = await supabaseAdmin.from('tournaments').select('season').eq('id', tournamentId).single();
  if (!t) return;

  const { data: results } = await supabaseAdmin
    .from('fantasy_results').select('league_id, user_id, total_score, rank');
  if (!results) return;

  const map = new Map<string, any>();
  for (const r of results) {
    const k = `${r.league_id}:${r.user_id}`;
    const e = map.get(k);
    if (e) { e.total += r.total_score ?? 0; e.count++; if (r.rank) e.best = Math.min(e.best, r.rank); }
    else map.set(k, { league_id: r.league_id, user_id: r.user_id, total: r.total_score ?? 0, count: 1, best: r.rank ?? 999 });
  }

  for (const s of map.values()) {
    await supabaseAdmin.from('season_standings').upsert({
      league_id: s.league_id, user_id: s.user_id, season: t.season,
      total_score: s.total, tournaments_played: s.count, best_finish: s.best,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'league_id,user_id,season' });
  }
}
