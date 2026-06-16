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
import { fetchLiveLeaderboard, fetchUpcomingEventField, parseESPNScore } from './espn';
import {
  applyFantasyRules, computeLeagueResults,
  buildAutoLineup, computeFoursomeHash,
  MISSED_DEADLINE_PENALTY_STROKES,
} from './scoring';
import { computeTopTierIds } from './field-tiers';
// notifyFieldPublished used to route through dispatchReminder /
// fieldPublishedMessage in src/lib/notifier.ts, but that pipeline has
// no real email driver registered (only a consoleDriver fallback), so
// the old path never sent anything. Refactored 2026-06-16 to use
// sendEmail directly via the new fieldPublishedEmail template.
import { effectivePickDeadline } from './pick-deadline';
import {
  sendEmail, rosterSetAdminEmail, missedDeadlineEmail,
  dailyScorecardEmail,
  tournamentRecapEmail,
  fieldPublishedEmail,
  type DailyScorecardLeaderboardRow,
  type DailyScorecardMyGolfer,
  type TournamentRecapLeaderboardRow,
  type TournamentRecapBestRound,
  type TournamentRecapSeasonRow,
} from './email';
import { generateDailyScorecardPdf, type ScorecardGolfer } from './scorecard-pdf';
// (Channel / ReminderTask were used by the old notifier path —
//  no longer needed after the 2026-06-16 notifyFieldPublished rewrite.)
import type { Score, Pick, FantasyResult, ESPNCompetitor } from '@/types';

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
      // Even when no tournaments are mid-flight, the missed-deadline
      // sweep can still have work to do: a tournament whose pick
      // deadline JUST passed but whose start_date is hours away
      // won't appear in the activeTournaments list. The sweep has
      // its own filter and is idempotent.
      await sweepMissedPicks();
      return { ok: true, message: 'No tournaments in active window', touched: 0, results: [] };
    }

    const results: SyncResult[] = [];
    for (const t of activeTournaments) {
      results.push(await syncTournament(t));
    }
    // Sweep AFTER syncTournament finishes so any newly-flipped
    // status / cut_score is in place when we check eligibility.
    await sweepMissedPicks();
    // Daily-scorecard email runs on its own 7pm CT Thu-Sun timer
    // (fairway-daily-scorecard.timer → /api/scheduled/daily-scorecard).
    // It used to fire from here every sync, but the per-hole "round
    // complete" gate (now relaxed) never tripped post-2026-05-14, and
    // a daily 7pm cadence is what the recap is for anyway.
    // Tournament-recap email — fires once per (league, tournament)
    // when a tournament's status flips to 'complete'. One email per
    // user with final standings + their best round + a season-
    // standings snapshot. Idempotent via tournament_recap_log.
    await detectAndSendTournamentRecaps();
    return { ok: true, results, touched: results.length };
  } catch (err) {
    console.error('Sync error:', err);
    return { ok: false, error: String(err) };
  }
}

/**
 * Per-tournament cut rule for the fallback used when ESPN doesn't
 * supply `cutLine`. ESPN's explicit cut value always wins when present;
 * this rule only fires during the post-R2 / pre-ESPN-cut-publish
 * window (typically Friday evening to Saturday morning).
 *
 * - `topN`             — top N players + ties make the cut. The Nth-
 *                        best 36-hole total IS the cut score.
 * - `topN+strokesBack` — Masters rule: top N + ties OR within K
 *                        strokes of the leader. The cut score is the
 *                        *more lenient* (higher / worse) of the two.
 *
 * Exported for tests/cut-rule.test.ts pinning the per-Major contract.
 */
export type CutRule =
  | { kind: 'topN'; n: number }
  | { kind: 'topN+strokesBack'; n: number; strokesBack: number };

export function inferCutRule(
  tournamentName: string,
  type: 'regular' | 'major',
): CutRule {
  if (type !== 'major') return { kind: 'topN', n: 65 };
  const name = tournamentName.toLowerCase();
  // The Masters — top 50 + ties AND within 10 strokes of the leader.
  if (name.includes('masters')) {
    return { kind: 'topN+strokesBack', n: 50, strokesBack: 10 };
  }
  // U.S. Open — top 60 + ties (USGA standard).
  if (name.includes('u.s. open') || name.includes('us open') || name.includes('u s open')) {
    return { kind: 'topN', n: 60 };
  }
  // The Open Championship (British Open) — top 70 + ties (R&A standard).
  if (name.includes('open championship') || name.includes('british open')) {
    return { kind: 'topN', n: 70 };
  }
  // PGA Championship — top 70 + ties (historical PGA of America rule).
  if (name.includes('pga championship')) {
    return { kind: 'topN', n: 70 };
  }
  // Unknown major — default to PGA Tour standard top 65 + ties.
  return { kind: 'topN', n: 65 };
}

/**
 * Apply a CutRule against a sorted ascending array of 36-hole totals
 * (low = good in golf). Returns the cut score (worst total that still
 * makes the cut — anyone tied at or better makes the cut).
 *
 * Fields under the rule's N (e.g. 40-man invitational) → everyone
 * makes the cut, delivered by the Math.min clamp on totals.length.
 *
 * Exported alongside inferCutRule for tests.
 */
export function applyCutRule(rule: CutRule, totalsSortedAsc: number[]): number {
  if (totalsSortedAsc.length === 0) {
    throw new Error('applyCutRule: empty totals array');
  }
  const cutByPosition = totalsSortedAsc[Math.min(rule.n - 1, totalsSortedAsc.length - 1)];
  if (rule.kind === 'topN') return cutByPosition;
  // Masters: cut is the MORE LENIENT (higher / worse) of position and
  // strokes-back. A player not in top 50 still makes the cut if within
  // K of the leader.
  const cutByStrokes = totalsSortedAsc[0] + rule.strokesBack;
  return Math.max(cutByPosition, cutByStrokes);
}

/**
 * Decide the new tournaments.status value from the ESPN event-level
 * status string + our cut-detection inference.
 *
 * Rewritten 2026-06-16. The previous version also flipped on a derived
 * "every cut survivor has linescores.length === 4 AND end_date < now"
 * signal, which misfired on 2026-06-14 during the rain-delayed RBC
 * Canadian Open R3/R4 overlap: ESPN populated the R4 linescore entry as
 * soon as R4 was on its schedule (early Sunday morning, before the field
 * had actually played), every cut survivor hit length 4, end_date had
 * already passed (stored as 02:00 CDT on the final day), and we flipped
 * to `complete` with R4=0 for everyone. Wrong winner declared via the
 * auto-firing recap email.
 *
 * We added that signal originally (2026-05-20) because ESPN's scoreboard
 * endpoint was reportedly stuck at STATUS_IN_PROGRESS for completed
 * events. Re-tested 2026-06-16: scoreboard DOES return STATUS_FINAL
 * once an event is truly final. Heuristic dropped.
 *
 * Backstop for the (rare) case where ESPN never reaches STATUS_FINAL —
 * e.g., a weather-shortened 54-hole event that their API keeps marked
 * in-progress: the weekly rankings-timer maintenance sweep at Mon 06:00
 * CT (in /api/sync-scores/rankings) flips any tournament with
 * `end_date < now - 24h` and status != complete. Worst-case lag ~24h.
 * Acceptable tradeoff vs the wrong-winner blast radius of the prior bug.
 *
 * Exported for tests/sync-status.test.ts.
 */
export function decideTournamentStatus(
  espnStatus: string,
  cutHasBeenMade: boolean,
): 'complete' | 'cut_made' | 'active' {
  // Substring match on "final" (lower-cased) so any X_FINAL variant
  // ESPN might add still flips us to complete.
  if (espnStatus.toLowerCase().includes('final')) return 'complete';
  return cutHasBeenMade ? 'cut_made' : 'active';
}

async function syncTournament(tournament: {
  id:             string;
  espn_event_id:  string;
  name:           string;
  type:           'regular' | 'major';
  cut_score:      number | null;
  end_date:       string;
}): Promise<SyncResult> {
  const { espn_event_id, id, name, type, cut_score, end_date } = tournament;
  const { competitors, cutScore: espnCut, status, currentRound } =
    await fetchLiveLeaderboard(espn_event_id);

  if (!competitors.length) return { skipped: true };

  // Cut-detection inference (revised 2026-05-23).
  //
  // ESPN's scoreboard fallback (used whenever /pga/leaderboard 404s)
  // returns cutScore: null and no per-golfer status, so we infer.
  //
  // Three triggers fire cutHasBeenMade:
  //
  //   1. espnCut !== null               — ESPN told us the cut line.
  //   2. currentRound >= 3              — R3 has started, cut is behind us.
  //   3. currentRound === 2 AND status === 'STATUS_PLAY_COMPLETE'
  //                                      — R2 just finished; the cut is
  //      mathematically determined even though ESPN's `period` field
  //      doesn't advance to 3 until R3 actually starts (Saturday
  //      morning). This is the post-R2-pre-R3 window we used to miss,
  //      where leaderboards displayed every golfer as `active` for
  //      ~14h Friday evening.
  //
  // When ESPN doesn't supply cutLine, fall back to a per-tournament
  // cut rule via inferCutRule + applyCutRule. ESPN's explicit cutLine
  // always wins when present; this branch only fires during the
  // post-R2 / pre-ESPN-cut-publish window.
  //
  // Regular PGA Tour events → top 65 + ties.
  // Majors → per-tournament rule:
  //   • The Masters       → top 50 + ties AND within 10 of the leader
  //   • U.S. Open         → top 60 + ties
  //   • The Open / British → top 70 + ties
  //   • PGA Championship  → top 70 + ties
  const r2PlayComplete = currentRound === 2 && status === 'STATUS_PLAY_COMPLETE';
  const cutHasBeenMade = currentRound >= 3 || r2PlayComplete || espnCut !== null;

  let effectiveCut: number | null = espnCut ?? cut_score;
  if (cutHasBeenMade && effectiveCut === null) {
    const totals: number[] = [];
    for (const c of competitors) {
      const ls = c.linescores ?? [];
      const r1 = ls[0]?.value, r2 = ls[1]?.value;
      if (typeof r1 === 'number' && typeof r2 === 'number') {
        totals.push(r1 + r2);
      }
    }
    if (totals.length > 0) {
      totals.sort((a, b) => a - b);
      effectiveCut = applyCutRule(inferCutRule(name, type), totals);
    }
  }

  const newStatus = decideTournamentStatus(status, cutHasBeenMade);

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
    holes_played:   number | null;
    round_1_holes:  number[] | null;
    round_2_holes:  number[] | null;
    round_3_holes:  number[] | null;
    round_4_holes:  number[] | null;
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

    // Cut-day backstop (revised 2026-05-23).
    //
    // With effectiveCut now computed at end of R2 (top-65+ties, see
    // the comment block above), missed-cut detection is a clean
    // score comparison: (r1 + r2) > effectiveCut → missed_cut.
    //
    // The legacy "linescores.length < 3" heuristic (proxy for "didn't
    // continue to R3") survives only as a fallback for the unlikely
    // case where effectiveCut couldn't be computed — e.g. nobody in
    // the field has both R1 and R2 line scores yet. Once R3 starts
    // it remains a valid signal too, since ESPN includes R3
    // placeholders for cut survivors but not for missed-cut golfers.
    //
    // Applied only when ESPN status was the default 'active' so we
    // don't override an explicit WD / DQ / MC from the leaderboard
    // endpoint when reachable. Also requires the cut to have been
    // made (avoids classifying mid-R2 WDs as missed_cut).
    if (cutMade && espnStatus === 'active') {
      const r1 = rounds[0], r2 = rounds[1];
      if (r1 != null && r2 != null) {
        if (effectiveCut !== null) {
          if ((r1 + r2) > effectiveCut) espnStatus = 'missed_cut';
        } else if (rounds.length < 3) {
          espnStatus = 'missed_cut';
        }
      }
    }

    const { fantasyScore, status: mappedStatus } = applyFantasyRules({
      scoreToParRaw: scoreStr, espnStatus, cutScore: effectiveCut, cutMade,
    });
    // ESPN's status.thru is round-relative (holes completed in the
    // CURRENT round, 0..18). Persist verbatim. Null when ESPN didn't
    // give us a value — we preserve any prior holes_played via the
    // COALESCE in the ON CONFLICT clause below so a scoreboard-fallback
    // sync doesn't blow away a real thru value from the prior
    // leaderboard sync.
    const holesPlayedFromEspn =
      typeof c.status?.thru === 'number' ? c.status.thru : null;

    // Per-hole strokes per round. ESPN may give us a partial array
    // for the in-progress round (e.g. 9 entries when thru=9), and
    // null for rounds not yet played. We pass exactly what the
    // normalizer extracted; the ON CONFLICT COALESCE further down
    // preserves a previously-recorded round when this sync's
    // payload doesn't include it.
    const hbr = c.holesByRound ?? [null, null, null, null];

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
      holes_played:   holesPlayedFromEspn,
      round_1_holes:  hbr[0] ?? null,
      round_2_holes:  hbr[1] ?? null,
      round_3_holes:  hbr[2] ?? null,
      round_4_holes:  hbr[3] ?? null,
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
          // Don't overwrite a real holes_played from a prior leaderboard
          // sync with NULL from a scoreboard-fallback sync. COALESCE
          // keeps the existing value when the new payload didn't carry
          // status.thru.
          holes_played:   eb.fn.coalesce(
            eb.ref('excluded.holes_played'),
            eb.ref('scores.holes_played'),
          ),
          // Per-hole arrays: preserve the prior round's data if this
          // payload doesn't include it. ESPN's scoreboard includes
          // the current round's inner linescores but not necessarily
          // every prior round once the tournament moves on. The
          // COALESCE pattern lets each round's data stick once
          // captured, instead of getting wiped by a sync that only
          // brings the current round.
          round_1_holes:  eb.fn.coalesce(
            eb.ref('excluded.round_1_holes'),
            eb.ref('scores.round_1_holes'),
          ),
          round_2_holes:  eb.fn.coalesce(
            eb.ref('excluded.round_2_holes'),
            eb.ref('scores.round_2_holes'),
          ),
          round_3_holes:  eb.fn.coalesce(
            eb.ref('excluded.round_3_holes'),
            eb.ref('scores.round_3_holes'),
          ),
          round_4_holes:  eb.fn.coalesce(
            eb.ref('excluded.round_4_holes'),
            eb.ref('scores.round_4_holes'),
          ),
          last_synced:    eb.ref('excluded.last_synced'),
        })),
      )
      .execute();
  }

  // ── Derive course par-by-hole from the field ──
  // ESPN doesn't expose course par directly; we derive it from any
  // golfer's per-hole (strokes - relative_to_par) pair. All golfers
  // who play hole N must agree (it's a course constant) — first one
  // with a definitive value wins. Persist on `tournaments.par_by_hole`
  // for the daily-scorecard PDF (migration 006, 2026-06-04).
  await derivePersistPar(id, competitors);

  await recomputeResults(id);
  return {
    tournament:   tournament.name,
    competitors:  competitors.length,
    currentRound,
    status:       newStatus,
  };
}

/**
 * Walk the field's per-hole strokes + relative-to-par arrays and
 * compute par[0..17] for every hole at least one golfer has played.
 * Merges with the existing tournaments.par_by_hole so a sync that
 * only carries the current round doesn't blank out par values for
 * holes scored on a prior round.
 *
 * Course par is a constant — for any hole, par == strokes - relative
 * for every golfer who played it. We take the first valid sample
 * we see per hole. Anomalies (e.g. ESPN tagging a 3 as "-2" by
 * mistake → par=5 for that golfer, par=4 for everyone else) would
 * surface only as inconsistencies between samples; we don't
 * cross-check (yet) — it would mask normal partial-data states.
 */
async function derivePersistPar(
  tournamentId: string,
  competitors: ESPNCompetitor[],
): Promise<void> {
  try {
    // Find existing par-by-hole so we only update on a real change.
    const existing = await db.selectFrom('tournaments')
      .select(['par_by_hole'])
      .where('id', '=', tournamentId)
      .executeTakeFirst();
    const par: Array<number | null> = Array.from(
      { length: 18 },
      (_, i) => (existing?.par_by_hole?.[i] ?? null) as number | null,
    );

    let changed = false;
    for (const c of competitors) {
      const hbr = c.holesByRound ?? [];
      const rbr = c.relByRound   ?? [];
      for (let r = 0; r < 4; r++) {
        const strokes = hbr[r];
        const rels    = rbr[r];
        if (!Array.isArray(strokes) || !Array.isArray(rels)) continue;
        const n = Math.min(strokes.length, rels.length, 18);
        for (let h = 0; h < n; h++) {
          if (par[h] != null) continue;
          const s = strokes[h];
          const rel = rels[h];
          if (typeof s !== 'number' || typeof rel !== 'number') continue;
          const p = s - rel;
          if (!Number.isFinite(p) || p < 3 || p > 6) continue;  // sanity
          par[h] = p;
          changed = true;
        }
      }
    }
    if (!changed) return;

    // Write back. We persist nulls as nulls inside the array — pg
    // arrays support sparse representation, but for simplicity we
    // strip trailing nulls and store only the prefix that has data.
    // Holes scored later will fill in via the same code path.
    let lastReal = -1;
    for (let i = 0; i < par.length; i++) if (par[i] != null) lastReal = i;
    const out = par.slice(0, lastReal + 1).map(v => (v == null ? null : v));
    // kysely doesn't love mixed-null arrays for INT[]; if there's
    // any null in the prefix, store only the leading contiguous run.
    let lastContig = 0;
    for (let i = 0; i < out.length; i++) {
      if (out[i] != null) lastContig = i + 1;
      else break;
    }
    const finalPar = out.slice(0, lastContig).filter(v => v != null) as number[];
    if (finalPar.length === 0) return;

    await db.updateTable('tournaments')
      .set({ par_by_hole: finalPar })
      .where('id', '=', tournamentId)
      .execute();
  } catch (err) {
    // Par derivation is non-critical — log and move on.
    // eslint-disable-next-line no-console
    console.warn(
      `[par-derive] failed for tournament=${tournamentId}:`,
      err instanceof Error ? err.message : err,
    );
  }
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

  // Batched upsert (perf — was O(leagues × members) round-trips,
  // one per row, with fsync per commit). Collect every league's
  // result rows into a single INSERT ... ON CONFLICT statement.
  // At ~5 leagues × 5 members during play, this cuts ~25 sequential
  // commits down to 1.
  const updated_at = new Date().toISOString();
  const allResultRows: Array<Omit<FantasyResult, 'id'> & { updated_at: string }> = [];
  for (const [, picks] of byLeague) {
    const results = computeLeagueResults(picks, scoreMap);
    for (const r of results) {
      allResultRows.push({ ...r, updated_at });
    }
  }
  if (allResultRows.length > 0) {
    await db.insertInto('fantasy_results')
      .values(allResultRows)
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

  // Batched season-standings upsert (perf, same reasoning as the
  // fantasy_results batch above). Reuses the same `updated_at`
  // timestamp so both tables reflect the same sync cycle.
  if (map.size > 0) {
    const standingsRows = Array.from(map.values()).map(s => ({
      league_id:          s.league_id,
      user_id:            s.user_id,
      season:             t.season,
      total_score:        s.total,
      tournaments_played: s.count,
      best_finish:        s.best,
      updated_at,
    }));
    await db.insertInto('season_standings')
      .values(standingsRows)
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

// ── Field availability sync (pre-tournament) ─────────────────
//
// Hits ESPN once per upcoming tournament whose field hasn't been
// published yet, and stamps `tournaments.field_published_at` the
// first time ESPN returns a non-empty competitors collection.
// Also seeds `golfers` + zero-score `scores` rows so the picks
// UI can filter the dropdown to actual field members and the
// `JOIN scores ON tournament_id` lookup just works.
//
// Called by the systemd `fairway-field.timer` (hourly Mon-Wed) via
// the /api/sync-field route. See infra/systemd/fairway-field.*.
//
// Why a separate sweep from runScoreSync():
//   - Scope: runScoreSync targets tournaments that have already
//     started (start_date <= now). Field publication is the BEFORE
//     window (start_date > now). The windowing is non-overlapping.
//   - Idempotency: once field_published_at is set we stop polling
//     that tournament. runScoreSync re-runs every 10 min Thu-Sun
//     to refresh in-progress scores.
//   - Different endpoint: fetchLiveLeaderboard uses
//     /pga/scoreboard?event=X, which silently returns the CURRENTLY
//     LIVE event regardless of the ?event= filter (observed
//     2026-05-23: requesting CSC returned Byron Nelson's roster).
//     runFieldSync uses fetchUpcomingEventField which date-filters
//     and verifies the returned event id matches the request.

export interface FieldSyncResult {
  tournament:    string;
  espn_event_id: string;
  competitors?:  number;
  /** True when this run stamped field_published_at for the first time. */
  published?:    boolean;
  /** True when ESPN's competitors collection was still empty. */
  pending?:      boolean;
  error?:        string;
}

export interface FieldSyncSummary {
  ok:        boolean;
  results?:  FieldSyncResult[];
  error?:    string;
  /** Number of tournaments whose field_published_at flipped this run. */
  touched?:  number;
}

export async function runFieldSync(): Promise<FieldSyncSummary> {
  try {
    const now     = new Date();
    // 14-day horizon: covers the standard Mon-Wed-of-tournament-week
    // polling window with slack for early-publishing fields and
    // tournaments whose start_date drifts (weather, schedule shuffle).
    const horizon = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    const candidates = await db.selectFrom('tournaments')
      .select(['id', 'espn_event_id', 'name', 'start_date'])
      .where('field_published_at', 'is', null)
      .where('start_date', '>',  now.toISOString())
      .where('start_date', '<', horizon.toISOString())
      .execute();

    if (candidates.length === 0) {
      // No field-publish work pending, but the missed-deadline sweep
      // may still have a Mon-Wed-deadline tournament to handle.
      // Idempotent, so safe to call here AND from runScoreSync.
      await sweepMissedPicks();
      return { ok: true, results: [], touched: 0 };
    }

    const results: FieldSyncResult[] = [];
    for (const t of candidates) {
      results.push(await checkAndPublishField(t));
    }
    await sweepMissedPicks();
    const touched = results.filter(r => r.published).length;
    return { ok: true, results, touched };
  } catch (err) {
    console.error('Field sync error:', err);
    return { ok: false, error: String(err) };
  }
}

async function checkAndPublishField(tournament: {
  id:            string;
  espn_event_id: string;
  name:          string;
  start_date:    string;
}): Promise<FieldSyncResult> {
  const { id, espn_event_id, name, start_date } = tournament;

  let competitors;
  try {
    competitors = await fetchUpcomingEventField(espn_event_id, start_date);
  } catch (err) {
    return { tournament: name, espn_event_id, error: String(err) };
  }

  if (!competitors.length) {
    return { tournament: name, espn_event_id, competitors: 0, pending: true };
  }

  // Field is out. Seed golfers + zero-score scores rows + stamp the
  // publication timestamp. `scores` rows use ON CONFLICT DO NOTHING
  // so later runScoreSync passes (which write real round/score data)
  // never get clobbered if this sweep happens to fire after R1
  // tee-off in some odd edge case.
  const nowIso = new Date().toISOString();
  for (const c of competitors) {
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

    await db.insertInto('scores')
      .values({
        tournament_id:  id,
        golfer_id:      golfer.id,
        espn_golfer_id: c.id,
        round_1:        null,
        round_2:        null,
        round_3:        null,
        round_4:        null,
        score_to_par:   null,
        position:       '',
        status:         'active',
        fantasy_score:  null,
        last_synced:    nowIso,
      })
      .onConflict(oc => oc
        .columns(['tournament_id', 'golfer_id'])
        .doNothing(),
      )
      .execute();
  }

  await db.updateTable('tournaments')
    .set({ field_published_at: nowIso })
    .where('id', '=', id)
    .execute();

  // "Field is set" notifications — fire once, on the NULL → set
  // transition. Routes through the same notifier pipeline as
  // pick-deadline reminders (src/lib/notifier.ts), so it inherits
  // the REMINDERS_LIVE gate: console logs in dev/staging, real
  // delivery only once a ChannelDriver is registered AND
  // REMINDERS_LIVE=true (today only the console driver is wired).
  //
  // We don't write to reminder_log here — the existing dedup index
  // is (user_id, tournament_id, channel), and reusing it would block
  // future pick-deadline reminders for the same user. The natural
  // dedup is the `field_published_at IS NULL` guard at the top of
  // runFieldSync: this code path runs at most once per tournament.
  // Failures within the loop are logged via console; the stamp above
  // commits the unlock regardless so users aren't blocked.
  await notifyFieldPublished({ tournamentId: id, tournamentName: name });

  // Admin notification — fire the operator-facing "roster set" email to
  // commissioners + co-commissioners of every league that overlaps this
  // tournament. Separate from notifyFieldPublished above: that one goes
  // to all league members (player-facing), this one is admin-flavored
  // and goes through sendEmail directly (no REMINDERS_LIVE gate — the
  // SMTP-not-configured check inside sendEmail is the dev/test safety
  // net). Same once-per-tournament guarantee as the user notification,
  // via the same NULL-gated runFieldSync prefilter. The hourly ESPN
  // sync is now the ONLY path that publishes a field — manual upload
  // was removed on Greg's call (2026-06-04).
  await notifyAdminsRosterSet({
    tournamentId:   id,
    tournamentName: name,
    golferCount:    competitors.length,
  });

  return {
    tournament:  name,
    espn_event_id,
    competitors: competitors.length,
    published:   true,
  };
}

/**
 * Send the "field is set, make your picks" email to every member of
 * every league whose date window includes this tournament.
 *
 * Rewritten 2026-06-16: the old version routed through the notifier
 * `dispatchReminder` pipeline, which has had no registered email
 * driver since the multi-channel reminder framework was scaffolded
 * in P9 — every "send" was a `console.log` from the consoleDriver
 * fallback. 0 reminder_log rows across 5 recent field-publish events
 * confirmed the path was dead.
 *
 * Now sends directly via sendEmail() / msmtp, same path as the daily
 * scorecard, tournament recap, and broadcast emails. Gated by the
 * NEW `reminder_preferences.field_published_enabled` column (migration
 * 014) — single dedicated toggle, default TRUE. Does NOT depend on
 * `email_enabled` (the general pick-reminder toggle) — these are
 * orthogonal preferences per the 2026-06-16 product decision.
 *
 * Best-effort throughout: per-recipient failures are logged but never
 * abort the parent sync run.
 */
async function notifyFieldPublished(args: {
  tournamentId:   string;
  tournamentName: string;
}): Promise<void> {
  const { tournamentId, tournamentName } = args;
  try {
    const t = await db.selectFrom('tournaments')
      .select(['id', 'start_date', 'end_date',
               'pick_deadline', 'pick_deadline_override'])
      .where('id', '=', tournamentId)
      .executeTakeFirst();
    if (!t) return;
    const pickDeadline = effectivePickDeadline(t);

    const leagues = await db.selectFrom('leagues')
      .select(['id', 'name', 'slug'])
      .where(eb => eb.or([
        eb('start_date', 'is', null),
        eb('start_date', '<=', t.end_date),
      ]))
      .where(eb => eb.or([
        eb('end_date', 'is', null),
        eb('end_date', '>=', t.start_date),
      ]))
      .execute();
    if (leagues.length === 0) return;

    const leagueIds = leagues.map(l => l.id);
    const members = await db.selectFrom('league_members')
      .innerJoin('profiles', 'profiles.id', 'league_members.user_id')
      .leftJoin('reminder_preferences', 'reminder_preferences.user_id', 'league_members.user_id')
      .select([
        'league_members.user_id', 'league_members.league_id',
        'profiles.email', 'profiles.display_name',
        'reminder_preferences.field_published_enabled',
      ])
      .where('league_members.league_id', 'in', leagueIds)
      .execute();
    if (members.length === 0) return;

    const leagueById = new Map(leagues.map(l => [l.id, l]));
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? '';

    let sent = 0, skipped = 0, failed = 0;

    for (const m of members) {
      if (!m.email) { skipped++; continue; }
      // The new column defaults TRUE in the schema (migration 014).
      // A LEFT JOIN miss (no prefs row) yields NULL — treat null/true
      // as opted-in. Only explicit `false` skips the send.
      if (m.field_published_enabled === false) { skipped++; continue; }

      const lg = leagueById.get(m.league_id);
      if (!lg) { skipped++; continue; }

      const { subject, text, html } = fieldPublishedEmail({
        recipientName:  m.display_name?.trim() || 'Player',
        leagueName:     lg.name,
        leagueSlug:     lg.slug,
        tournamentName,
        pickDeadline,
        siteUrl,
      });

      try {
        const ok = await sendEmail({ to: m.email, subject, text, html });
        if (ok) {
          sent++;
          // eslint-disable-next-line no-console
          console.log(`[field-publish] ${tournamentName} / ${lg.name} → ${m.email} sent=true`);
        } else {
          failed++;
          // eslint-disable-next-line no-console
          console.log(`[field-publish] ${tournamentName} / ${lg.name} → ${m.email} sent=false`);
        }
      } catch (err) {
        failed++;
        // eslint-disable-next-line no-console
        console.error(
          `[field-publish] send failed for user=${m.user_id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[field-publish] ${tournamentName}: sent=${sent} skipped=${skipped} failed=${failed} across ${leagues.length} league(s)`,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[field-publish] notify pass failed:', err);
  }
}

/**
 * Admin-facing "roster has been set" email. Recipients are the
 * commissioners + co-commissioners of every league whose date window
 * includes the tournament — they're the ones who'd need to know the
 * field is locked in.
 *
 * Each unique recipient gets ONE email listing all their relevant
 * leagues; a commissioner who runs 3 leagues that all include this
 * tournament doesn't get 3 emails.
 *
 * Best-effort: any error inside is logged, never thrown. Called from
 * checkAndPublishField on the once-per-tournament
 * `field_published_at IS NULL → set` transition. The hourly ESPN sync
 * is now the sole publish path (manual upload was retired 2026-06-04),
 * so this fires at most once per tournament with no race-with-self.
 */
export async function notifyAdminsRosterSet(args: {
  tournamentId:   string;
  tournamentName: string;
  golferCount:    number;
}): Promise<void> {
  const { tournamentId, tournamentName, golferCount } = args;
  try {
    const t = await db.selectFrom('tournaments')
      .select(['id', 'start_date', 'end_date'])
      .where('id', '=', tournamentId)
      .executeTakeFirst();
    if (!t) return;

    // Same overlap query notifyFieldPublished uses — leagues whose
    // [start_date, end_date] includes this tournament. Open-ended on
    // either side means "no constraint on that side".
    const leagues = await db.selectFrom('leagues')
      .select(['id', 'name', 'slug'])
      .where(eb => eb.or([
        eb('start_date', 'is', null),
        eb('start_date', '<=', t.end_date),
      ]))
      .where(eb => eb.or([
        eb('end_date', 'is', null),
        eb('end_date', '>=', t.start_date),
      ]))
      .execute();
    if (leagues.length === 0) return;

    const leagueIds = leagues.map(l => l.id);
    const leagueById = new Map(leagues.map(l => [l.id, l]));

    // Commissioners + co-commissioners only. Regular members get the
    // player-facing notifyFieldPublished email; this is the admin-tier.
    const admins = await db.selectFrom('league_members')
      .select(['user_id', 'league_id'])
      .where('league_id', 'in', leagueIds)
      .where('role', 'in', ['commissioner', 'co_commissioner'])
      .execute();
    if (admins.length === 0) return;

    const adminIds = Array.from(new Set(admins.map(a => a.user_id)));
    const profiles = await db.selectFrom('profiles')
      .select(['id', 'email', 'display_name'])
      .where('id', 'in', adminIds)
      .execute();
    const profileById = new Map(profiles.map(p => [p.id, p]));

    // Group leagues by admin user so each unique recipient gets one
    // email listing every relevant league they run. Filter to admins
    // whose profile actually has an email (defensive — profiles.email
    // is NOT NULL in schema but covers any future schema relaxation).
    const leaguesByAdmin = new Map<string, Array<{ name: string; slug: string }>>();
    for (const a of admins) {
      const l = leagueById.get(a.league_id);
      if (!l) continue;
      if (!leaguesByAdmin.has(a.user_id)) leaguesByAdmin.set(a.user_id, []);
      leaguesByAdmin.get(a.user_id)!.push({ name: l.name, slug: l.slug });
    }

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? '';

    for (const [userId, userLeagues] of leaguesByAdmin) {
      const profile = profileById.get(userId);
      if (!profile?.email) continue;

      const { subject, text, html } = rosterSetAdminEmail({
        displayName:    profile.display_name || 'Commissioner',
        tournamentName,
        golferCount,
        leagues:        userLeagues,
        siteUrl,
      });

      try {
        const ok = await sendEmail({ to: profile.email, subject, text, html });
        // eslint-disable-next-line no-console
        console.log(
          `[roster-set-admin] ${tournamentName} → ${profile.email} ` +
            `leagues=${userLeagues.length} sent=${ok}`,
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[roster-set-admin] send failed for user=${userId} email=${profile.email}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } catch (err) {
    // Never fail the caller because of a notification glitch.
    // eslint-disable-next-line no-console
    console.error('[roster-set-admin] notify pass failed:', err);
  }
}

// ============================================================
// MISSED-DEADLINE AUTO-ASSIGN SWEEP
// ============================================================
/**
 * Find every (user, league, tournament) where:
 *   - the pick deadline (effective: override-aware) has passed,
 *   - the user belongs to a league whose date window includes the
 *     tournament,
 *   - the tournament status is 'upcoming' or 'active' (no point
 *     auto-assigning after the cut or after final scoring),
 *   - the user has not submitted a pick for that league+tournament,
 *
 * and for each such gap:
 *   1. Generate a random unique lineup excluding top-4 of each tier
 *      by OWGR (buildAutoLineup in scoring.ts).
 *   2. INSERT a picks row with penalty_strokes=MISSED_DEADLINE_PENALTY_STROKES
 *      and is_locked=true.
 *   3. Send the missed-deadline email to the user.
 *
 * Idempotent: a user who already has any picks row (including a
 * previously auto-assigned one) is skipped — the existence of the row,
 * not the value of penalty_strokes, is the gate. Failures per
 * assignment are logged and don't abort the loop.
 *
 * Called from both runScoreSync (Thu-Sun every 10 min) and
 * runFieldSync (Mon-Wed hourly) so the latency between deadline-pass
 * and assignment is bounded to ≤1 hour across the whole week.
 */
async function sweepMissedPicks(): Promise<void> {
  try {
    const nowIso = new Date().toISOString();

    // ── 1. Candidate tournaments: deadline passed, status not done.
    const candidates = await db.selectFrom('tournaments')
      .select([
        'id', 'name', 'start_date', 'end_date',
        'pick_deadline', 'pick_deadline_override', 'status',
      ])
      .where('status', 'in', ['upcoming', 'active'])
      .execute();

    const dueNow = candidates.filter(t => {
      const dl = effectivePickDeadline(t);
      return dl !== null && dl.getTime() <= Date.now();
    });

    if (dueNow.length === 0) return;

    for (const t of dueNow) {
      await sweepMissedPicksForTournament(t, nowIso);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[missed-deadline-sweep] pass failed:', err);
  }
}

/**
 * Per-tournament arm of sweepMissedPicks. Split out so a failure on
 * one tournament doesn't stop the others.
 */
async function sweepMissedPicksForTournament(
  t: {
    id: string;
    name: string;
    start_date: string;
    end_date:   string;
    pick_deadline:          string | null;
    pick_deadline_override: string | null;
    status:                 string;
  },
  nowIso: string,
): Promise<void> {
  // ── 2. Leagues whose window includes this tournament.
  const leagues = await db.selectFrom('leagues')
    .select(['id', 'name', 'slug'])
    .where(eb => eb.or([
      eb('start_date', 'is', null),
      eb('start_date', '<=', t.end_date),
    ]))
    .where(eb => eb.or([
      eb('end_date', 'is', null),
      eb('end_date', '>=', t.start_date),
    ]))
    .execute();
  if (leagues.length === 0) return;

  const leagueIds = leagues.map(l => l.id);
  const leagueById = new Map(leagues.map(l => [l.id, l]));

  // ── 3. Members + existing picks across all candidate leagues.
  const [members, existingPicks] = await Promise.all([
    db.selectFrom('league_members')
      .select(['user_id', 'league_id'])
      .where('league_id', 'in', leagueIds)
      .execute(),
    db.selectFrom('picks')
      .select(['league_id', 'user_id', 'golfer_tuple_hash'])
      .where('league_id', 'in', leagueIds)
      .where('tournament_id', '=', t.id)
      .execute(),
  ]);

  if (members.length === 0) return;

  // ── 4. Compute missing-pick set per league + seed taken hashes per league.
  // Key: `${leagueId}\t${userId}`. Easier than nested maps for the
  // set-difference computation below.
  const submitted = new Set<string>();
  const takenHashByLeague = new Map<string, Set<string>>();
  for (const lid of leagueIds) takenHashByLeague.set(lid, new Set());

  for (const p of existingPicks) {
    submitted.add(`${p.league_id}\t${p.user_id}`);
    if (p.golfer_tuple_hash) {
      takenHashByLeague.get(p.league_id)!.add(p.golfer_tuple_hash);
    }
  }

  const missing = members.filter(m =>
    !submitted.has(`${m.league_id}\t${m.user_id}`),
  );
  if (missing.length === 0) return;

  // ── 5. Field for the tournament. Same query the picks page uses.
  // Per-tournament tier (top 24 ranked in THIS field) drives the
  // split inside buildAutoLineup — computed once here, reused for
  // every missing-pick user we assign in this sweep.
  const fieldRows = await db.selectFrom('scores')
    .innerJoin('golfers', 'golfers.id', 'scores.golfer_id')
    .select([
      'golfers.id as id', 'golfers.name as name',
      'golfers.owgr_rank as owgr_rank',
    ])
    .where('scores.tournament_id', '=', t.id)
    .execute();
  if (fieldRows.length === 0) {
    // No field means we can't auto-assign; tournament hasn't published
    // yet. The picks page is also blocked in this state, so a user
    // technically didn't have anything to pick. Skip silently.
    return;
  }
  const topTierIds = computeTopTierIds(fieldRows);

  // ── 6. Profile lookup for emails.
  const userIds = Array.from(new Set(missing.map(m => m.user_id)));
  const profiles = await db.selectFrom('profiles')
    .select(['id', 'email', 'display_name'])
    .where('id', 'in', userIds)
    .execute();
  const profileById = new Map(profiles.map(p => [p.id, p]));
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? '';

  // ── 7. Per-missing-user assign loop.
  for (const m of missing) {
    const league = leagueById.get(m.league_id);
    if (!league) continue;
    const profile = profileById.get(m.user_id);

    const taken = takenHashByLeague.get(m.league_id)!;
    const lineup = buildAutoLineup({
      fieldGolfers: fieldRows.map(r => ({
        id:        r.id,
        name:      r.name,
        owgr_rank: r.owgr_rank,
      })),
      topTierIds,
      takenHashes: taken,
    });

    if (!lineup.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[missed-deadline-sweep] cannot build lineup for user=${m.user_id} ` +
        `league=${m.league_id} tournament=${t.id}: ${lineup.reason}`,
      );
      continue;
    }

    // Insert. The DB trigger recomputes golfer_tuple_hash; we pre-compute
    // the same value (via computeFoursomeHash, kept in lockstep with the
    // trigger) so we can immediately seed `taken` for any LATER user we
    // assign in this same sweep.
    try {
      await db.insertInto('picks')
        .values({
          league_id:        m.league_id,
          tournament_id:    t.id,
          user_id:          m.user_id,
          golfer_1_id:      lineup.golferIds[0],
          golfer_2_id:      lineup.golferIds[1],
          golfer_3_id:      lineup.golferIds[2],
          golfer_4_id:      lineup.golferIds[3],
          is_locked:        true,
          submitted_at:     nowIso,
          penalty_strokes:  MISSED_DEADLINE_PENALTY_STROKES,
        })
        // Idempotency belt: if a previous sweep pass already inserted
        // a row for this user+league+tournament, the (league_id,
        // tournament_id, user_id) unique constraint catches it and
        // we skip — DON'T overwrite, because that would re-fire the
        // email AND possibly invalidate a user-submitted pick if some
        // sequencing weirdness landed them as missing.
        .onConflict(oc => oc
          .columns(['league_id', 'tournament_id', 'user_id'])
          .doNothing(),
        )
        .execute();
      taken.add(computeFoursomeHash(lineup.golferIds));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[missed-deadline-sweep] insert failed for user=${m.user_id} ` +
        `league=${m.league_id} tournament=${t.id}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    // ── Email the user. Best-effort; failure doesn't roll back the
    // insert (the user has a valid lineup; they'd just not get the
    // heads-up email).
    if (profile?.email) {
      try {
        // Build slot-labeled golfer list for the email. The pick row
        // stores ids in slot order, so we can do a direct lookup.
        const golfersByIdLocal = new Map(fieldRows.map(r => [r.id, r.name]));
        const lineupNamed = lineup.golferIds.map((id, idx) => ({
          slot: idx + 1,
          name: golfersByIdLocal.get(id) ?? '(unknown)',
        }));

        const { subject, text, html } = missedDeadlineEmail({
          displayName:    profile.display_name || 'Player',
          leagueName:     league.name,
          leagueSlug:     league.slug,
          tournamentName: t.name,
          golfers:        lineupNamed,
          penaltyStrokes: MISSED_DEADLINE_PENALTY_STROKES,
          siteUrl,
        });
        const ok = await sendEmail({ to: profile.email, subject, text, html });
        // eslint-disable-next-line no-console
        console.log(
          `[missed-deadline-sweep] ${t.name} / ${league.name} → ${profile.email} ` +
          `sent=${ok}`,
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[missed-deadline-sweep] email failed for user=${m.user_id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}

// ============================================================
// DAILY-SCORECARD EMAIL SWEEP (post-round-complete)
// ============================================================
/**
 * Greg's 2026-06-04 spec: when every cut-survivor in the field
 * finishes the current round, send one email per (user, league)
 * with the league standings + an attached PDF scorecard of the
 * user's foursome.
 *
 * Trigger: for each in-flight tournament (status='active' or
 * 'cut_made'), iterate rounds 1..4. A round is "complete" when
 * every golfer with status='active' or 'complete' has a non-NULL
 * round_N_holes array of length 18. (Missed-cut / withdrawn /
 * disqualified golfers are excluded — they're not expected to
 * play the post-cut rounds.) For each complete-but-not-yet-sent
 * round, fire emails to every league whose window includes the
 * tournament.
 *
 * Idempotency: daily_scorecard_log (league_id, tournament_id,
 * round_num) UNIQUE row guards against double-send. The sweep
 * runs from runScoreSync every 10 minutes Thu-Sun, so a round
 * landing on the trigger boundary still only fires once.
 *
 * Best-effort throughout: per-tournament, per-round, and per-user
 * failures are logged and skipped without aborting the loop.
 */
export async function detectAndSendDailyScorecards(): Promise<void> {
  try {
    const candidateTournaments = await db.selectFrom('tournaments')
      .select(['id', 'name', 'start_date', 'end_date', 'status'])
      .where('status', 'in', ['active', 'cut_made', 'complete'])
      .execute();

    for (const t of candidateTournaments) {
      try {
        await sendScorecardsForCompletedRounds(t);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[daily-scorecard] failure on tournament=${t.id} (${t.name}):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[daily-scorecard] sweep pass failed:', err);
  }
}

/**
 * Per-tournament arm: for each round 1..4 with ANY scored data,
 * send the daily scorecard (idempotent via daily_scorecard_log).
 *
 * Gate (relaxed 2026-06-13): we no longer require every cut survivor
 * to have an 18-element `round_N_holes` array. ESPN's `/pga/scoreboard`
 * fallback (the only endpoint we get since `/pga/leaderboard` started
 * 404ing 2026-05-14) doesn't reliably populate inner per-hole linescores
 * for completed rounds — especially R4 — so the old gate never tripped
 * and R3/R4 scorecards never went out for any tournament after that.
 * Now we fire on the integer round total (`scores.round_N`), which IS
 * populated by both endpoints. The daily-scorecard timer (7pm CT Thu-Sun)
 * is the schedule; this function just picks which rounds have data.
 */
async function sendScorecardsForCompletedRounds(t: {
  id: string;
  name: string;
  start_date: string;
  end_date:   string;
  status:     string;
}): Promise<void> {
  const fieldRows = await db.selectFrom('scores')
    .innerJoin('golfers', 'golfers.id', 'scores.golfer_id')
    .select([
      'golfers.id as golfer_id',
      'golfers.name as golfer_name',
      'scores.status',
      'scores.round_1', 'scores.round_2', 'scores.round_3', 'scores.round_4',
    ])
    .where('scores.tournament_id', '=', t.id)
    .execute();

  if (fieldRows.length === 0) return;

  // Pre-fetch leagues whose window overlaps this tournament.
  const leagues = await db.selectFrom('leagues')
    .select(['id', 'name', 'slug'])
    .where(eb => eb.or([
      eb('start_date', 'is', null),
      eb('start_date', '<=', t.end_date),
    ]))
    .where(eb => eb.or([
      eb('end_date', 'is', null),
      eb('end_date', '>=', t.start_date),
    ]))
    .execute();
  if (leagues.length === 0) return;

  for (let roundNum = 1; roundNum <= 4; roundNum++) {
    const totalCol = `round_${roundNum}` as const;
    // Filter to golfers expected to play this round: status active
    // or complete. (Pre-cut: all are active. Post-cut: MC/WD/DQ
    // are excluded.)
    const expectedPlayers = fieldRows.filter(
      r => r.status === 'active' || r.status === 'complete',
    );
    if (expectedPlayers.length === 0) continue;
    // Fire ONLY when every expected player has a round_N total
    // (tightened 2026-06-16 from "any" to "all"). This handles rounds
    // that bleed across days due to rain delays / darkness — the 7pm
    // sweep on day-of will SKIP an incomplete round, and the next
    // day's 7pm sweep will catch it once the stragglers post.
    //
    // Previous "any" gate sent emails based on the leading group's
    // score even when most of the field was still on course, which
    // mailed misleading day-snapshot leaderboards. The 7pm timer is
    // a wall-clock fence, not a "is the round done yet" signal.
    const allFinished = expectedPlayers.every(r => {
      const total = (r as Record<string, unknown>)[totalCol];
      return total != null;
    });
    if (!allFinished) continue;

    // Idempotent per (league, tournament, round) — re-runs of the
    // same day's sweep are cheap no-ops.
    for (const lg of leagues) {
      try {
        await sendDailyScorecardForLeague({
          tournament: t,
          league:     lg,
          roundNum,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[daily-scorecard] send failed for league=${lg.id} ` +
          `tournament=${t.id} round=${roundNum}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}

/**
 * Pure helper for the "should we fire round N's scorecard yet?" gate.
 * Extracted from sendScorecardsForCompletedRounds so tests don't have
 * to spin up the DB. See decideTournamentStatus for the parallel
 * pattern.
 *
 * Tightened 2026-06-16: previously fired as soon as ANY expected
 * player had a non-null round_N total. Now requires every expected
 * player (status active/complete, i.e. cut survivors) to have a
 * non-null total — accommodates rain/darkness rounds that finish the
 * next morning without sending day-of half-baked leaderboards.
 */
export function isRoundReadyForScorecard(args: {
  expectedPlayers: Array<{ status: string; roundTotal: number | null }>;
}): boolean {
  const cutSurvivors = args.expectedPlayers.filter(
    p => p.status === 'active' || p.status === 'complete',
  );
  if (cutSurvivors.length === 0) return false;
  return cutSurvivors.every(p => p.roundTotal != null);
}

/**
 * One-league arm: builds the leaderboard + per-user PDFs and sends
 * emails. Idempotent via the daily_scorecard_log INSERT-or-skip.
 */
async function sendDailyScorecardForLeague(args: {
  tournament: { id: string; name: string; start_date: string; end_date: string; status: string };
  league:     { id: string; name: string; slug: string };
  roundNum:   number;
}): Promise<void> {
  const { tournament, league, roundNum } = args;

  // Pull par_by_hole once per league iteration. Course par is
  // tournament-wide so this is constant across all recipients.
  const tRow = await db.selectFrom('tournaments')
    .select(['par_by_hole'])
    .where('id', '=', tournament.id)
    .executeTakeFirst();
  const parByHole = (tRow?.par_by_hole as number[] | null) ?? null;

  // ── Dedup: reserve the (league, tournament, round) slot. If a
  //    concurrent sweep already inserted, this is a no-op and we
  //    bail before doing any of the expensive work below.
  const reserved = await db.insertInto('daily_scorecard_log')
    .values({
      league_id:      league.id,
      tournament_id:  tournament.id,
      round_num:      roundNum,
      emails_sent:    0,
    })
    .onConflict(oc => oc
      .columns(['league_id', 'tournament_id', 'round_num'])
      .doNothing(),
    )
    .returning('id')
    .executeTakeFirst();
  if (!reserved) {
    // Another sweep cycle (or a different worker) got here first.
    return;
  }

  // ── Hydrate everything we need in one batch ──
  // LEFT JOIN reminder_preferences so we can filter recipients by
  // nightly_recap_enabled below. NULL (no prefs row) is treated as
  // opted-in — consistent with the rest of the codebase's
  // default-on assumption for users predating migration 004.
  const [members, picks, fantasyResults, scoreRows] = await Promise.all([
    db.selectFrom('league_members')
      .innerJoin('profiles', 'profiles.id', 'league_members.user_id')
      .leftJoin('reminder_preferences', 'reminder_preferences.user_id', 'league_members.user_id')
      .select([
        'league_members.user_id', 'profiles.email', 'profiles.display_name',
        'reminder_preferences.nightly_recap_enabled',
      ])
      .where('league_members.league_id', '=', league.id)
      .execute(),
    db.selectFrom('picks')
      .select([
        'user_id', 'penalty_strokes',
        'golfer_1_id', 'golfer_2_id', 'golfer_3_id', 'golfer_4_id',
      ])
      .where('league_id', '=', league.id)
      .where('tournament_id', '=', tournament.id)
      .execute(),
    db.selectFrom('fantasy_results')
      .select(['user_id', 'total_score', 'rank',
               'golfer_1_score', 'golfer_2_score', 'golfer_3_score', 'golfer_4_score',
               'counting_golfers'])
      .where('league_id', '=', league.id)
      .where('tournament_id', '=', tournament.id)
      .execute(),
    db.selectFrom('scores')
      .innerJoin('golfers', 'golfers.id', 'scores.golfer_id')
      .select([
        'golfers.id as golfer_id',
        'golfers.name as golfer_name',
        'scores.status',
        'scores.score_to_par',
        'scores.round_1_holes', 'scores.round_2_holes',
        'scores.round_3_holes', 'scores.round_4_holes',
        'scores.round_1', 'scores.round_2', 'scores.round_3', 'scores.round_4',
      ])
      .where('scores.tournament_id', '=', tournament.id)
      .execute(),
  ]);

  if (members.length === 0) return;

  // ── Build the leaderboard rows for this league ──
  const profileByUser = new Map(members.map(m => [m.user_id, m]));
  const frByUser = new Map(fantasyResults.map(f => [f.user_id, f]));
  const leaderboard: DailyScorecardLeaderboardRow[] = members
    .map((m, i) => {
      const fr = frByUser.get(m.user_id);
      return {
        rank:        fr?.rank ?? (members.length + i + 1),
        displayName: m.display_name || 'Player',
        totalScore:  fr?.total_score ?? null,
        isMe:        false,  // filled in per-recipient below
      };
    })
    .sort((a, b) => {
      // null totals sink to the bottom; otherwise lower = better.
      if (a.totalScore == null && b.totalScore == null) return 0;
      if (a.totalScore == null) return  1;
      if (b.totalScore == null) return -1;
      return a.totalScore - b.totalScore;
    });

  // ── Per-recipient render loop ──
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? '';
  const dateLabel = formatTournamentRoundDate(tournament, roundNum);
  const scoreByGolferId = new Map(scoreRows.map(s => [s.golfer_id, s]));
  const pickByUser = new Map(picks.map(p => [p.user_id, p]));

  let emailsSent = 0;

  for (const m of members) {
    if (!m.email) continue;
    // Per-user opt-out from the daily scorecard. nightly_recap_enabled
    // defaults TRUE in the schema (migration 009) and is treated as
    // TRUE here when the LEFT JOIN yields NULL (no prefs row at all).
    if (m.nightly_recap_enabled === false) continue;
    const pick = pickByUser.get(m.user_id);
    if (!pick) continue;        // skipped: no foursome
    const fr   = frByUser.get(m.user_id);

    // Build the foursome for this user's email body + PDF.
    const slotGolferIds: Array<string | null> = [
      pick.golfer_1_id, pick.golfer_2_id, pick.golfer_3_id, pick.golfer_4_id,
    ];
    const countingSlots = new Set<number>(
      (fr?.counting_golfers ?? []) as number[],
    );
    const myFoursome: DailyScorecardMyGolfer[] = slotGolferIds.map((gid, idx) => {
      const slot = idx + 1;
      const s = gid ? scoreByGolferId.get(gid) : null;
      const roundScoreRaw = s
        ? ([s.round_1, s.round_2, s.round_3, s.round_4][roundNum - 1] ?? null)
        : null;
      const status = s?.status;
      const statusBadge =
        status === 'missed_cut'   ? 'MC'
      : status === 'withdrawn'    ? 'WD'
      : status === 'disqualified' ? 'DQ'
      : null;
      const cumulative = (fr as Record<string, unknown> | undefined)?.[`golfer_${slot}_score`] as number | null | undefined ?? null;
      return {
        slot,
        name:        s?.golfer_name ?? '(unknown)',
        roundScore:  roundScoreRaw as number | null,
        cumulative,
        countedSlot: countingSlots.has(slot),
        statusBadge,
      };
    });

    // Leaderboard with isMe set for this recipient.
    const lbForRecipient: DailyScorecardLeaderboardRow[] = leaderboard.map(r => ({
      ...r,
      isMe: r.displayName === (m.display_name || 'Player'),
    }));

    // Build the PDF.
    const pdfGolfers: ScorecardGolfer[] = slotGolferIds.map((gid, idx) => {
      const s = gid ? scoreByGolferId.get(gid) : null;
      const arr = s
        ? ([s.round_1_holes, s.round_2_holes, s.round_3_holes, s.round_4_holes][roundNum - 1] ?? null)
        : null;
      return {
        name:       s?.golfer_name ?? '(unknown)',
        slotLabel:  idx < 2 ? `Top ${idx + 1}` : `DH ${idx - 1}`,
        strokes:    Array.isArray(arr) ? arr : [],
      };
    });

    let pdf: Buffer | null = null;
    try {
      pdf = await generateDailyScorecardPdf({
        tournamentName: tournament.name,
        roundNum,
        leagueName:     league.name,
        userName:       m.display_name || 'Player',
        dateLabel,
        golfers:        pdfGolfers,
        parByHole,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[daily-scorecard] PDF generation failed for user=${m.user_id}:`,
        err instanceof Error ? err.message : err,
      );
      // Send the email without the attachment rather than skipping
      // entirely — the body still has useful info.
    }

    const { subject, text, html } = dailyScorecardEmail({
      displayName:    m.display_name || 'Player',
      leagueName:     league.name,
      leagueSlug:     league.slug,
      tournamentName: tournament.name,
      roundNum,
      dateLabel,
      leaderboard:    lbForRecipient,
      myFoursome,
      siteUrl,
    });

    try {
      const ok = await sendEmail({
        to:      m.email,
        subject,
        text,
        html,
        attachments: pdf ? [{
          filename:    `scorecard-${tournament.name.replace(/\s+/g, '_')}-R${roundNum}.pdf`,
          content:     pdf,
          contentType: 'application/pdf',
        }] : undefined,
      });
      if (ok) emailsSent++;
      // eslint-disable-next-line no-console
      console.log(
        `[daily-scorecard] ${tournament.name} R${roundNum} / ${league.name} ` +
        `→ ${m.email} sent=${ok}`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[daily-scorecard] send failed for user=${m.user_id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── Update the log row with the actual send count ──
  try {
    await db.updateTable('daily_scorecard_log')
      .set({ emails_sent: emailsSent })
      .where('league_id',     '=', league.id)
      .where('tournament_id', '=', tournament.id)
      .where('round_num',     '=', roundNum)
      .execute();
  } catch {
    // Non-critical telemetry — log update failure shouldn't break the run.
  }
}

// ============================================================
// TOURNAMENT-RECAP EMAIL
//
// Once a tournament's status flips to 'complete' we send one email
// per (user, league) with final standings, the user's best round,
// and a season-standings snapshot. Idempotency is via
// tournament_recap_log (migration 009).
//
// Per-user opt-out via reminder_preferences.tournament_recap_enabled
// (default TRUE — opt-out, not opt-in).
//
// Mirrors the structure of detectAndSendDailyScorecards (above) so
// they stay easy to read side-by-side.
// ============================================================

/**
 * Sweep entry point. Called from runScoreSync once per sync cycle.
 */
async function detectAndSendTournamentRecaps(): Promise<void> {
  try {
    const completedTournaments = await db.selectFrom('tournaments')
      .select(['id', 'name', 'start_date', 'end_date', 'status'])
      .where('status', '=', 'complete')
      .execute();

    for (const t of completedTournaments) {
      // Pre-fetch leagues whose window overlaps this tournament. Same
      // overlap rule as the daily-scorecard arm.
      const leagues = await db.selectFrom('leagues')
        .select(['id', 'name', 'slug'])
        .where(eb => eb.or([
          eb('start_date', 'is', null),
          eb('start_date', '<=', t.end_date),
        ]))
        .where(eb => eb.or([
          eb('end_date', 'is', null),
          eb('end_date', '>=', t.start_date),
        ]))
        .execute();

      for (const lg of leagues) {
        try {
          await sendTournamentRecapForLeague({ tournament: t, league: lg });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            `[tournament-recap] send failed for league=${lg.id} ` +
            `tournament=${t.id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[tournament-recap] sweep pass failed:', err);
  }
}

/**
 * One-league arm: builds final standings + per-user best round +
 * season snapshot, then sends. Idempotent via tournament_recap_log.
 */
async function sendTournamentRecapForLeague(args: {
  tournament: { id: string; name: string; start_date: string; end_date: string; status: string };
  league:     { id: string; name: string; slug: string };
}): Promise<void> {
  const { tournament, league } = args;

  // ── Dedup: reserve the (league, tournament) slot. ──
  const reserved = await db.insertInto('tournament_recap_log')
    .values({
      league_id:      league.id,
      tournament_id:  tournament.id,
      emails_sent:    0,
    })
    .onConflict(oc => oc
      .columns(['league_id', 'tournament_id'])
      .doNothing(),
    )
    .returning('id')
    .executeTakeFirst();
  if (!reserved) return;

  // ── Hydrate everything we need in one batch. LEFT JOIN on
  //    reminder_preferences so we can filter by tournament_recap_enabled. ──
  const [members, picks, fantasyResults, scoreRows, seasonRows] = await Promise.all([
    db.selectFrom('league_members')
      .innerJoin('profiles', 'profiles.id', 'league_members.user_id')
      .leftJoin('reminder_preferences', 'reminder_preferences.user_id', 'league_members.user_id')
      .select([
        'league_members.user_id', 'profiles.email', 'profiles.display_name',
        'reminder_preferences.tournament_recap_enabled',
      ])
      .where('league_members.league_id', '=', league.id)
      .execute(),
    db.selectFrom('picks')
      .select(['user_id', 'golfer_1_id', 'golfer_2_id', 'golfer_3_id', 'golfer_4_id'])
      .where('league_id', '=', league.id)
      .where('tournament_id', '=', tournament.id)
      .execute(),
    db.selectFrom('fantasy_results')
      .select(['user_id', 'total_score', 'rank'])
      .where('league_id', '=', league.id)
      .where('tournament_id', '=', tournament.id)
      .execute(),
    db.selectFrom('scores')
      .innerJoin('golfers', 'golfers.id', 'scores.golfer_id')
      .select([
        'golfers.id as golfer_id',
        'golfers.name as golfer_name',
        'scores.round_1', 'scores.round_2', 'scores.round_3', 'scores.round_4',
      ])
      .where('scores.tournament_id', '=', tournament.id)
      .execute(),
    db.selectFrom('season_standings')
      .innerJoin('profiles', 'profiles.id', 'season_standings.user_id')
      .select([
        'season_standings.user_id', 'profiles.display_name',
        'season_standings.total_score', 'season_standings.tournaments_played',
        'season_standings.rank',
      ])
      .where('season_standings.league_id', '=', league.id)
      .execute(),
  ]);

  if (members.length === 0) return;

  // ── Final-standings rows (sorted; lower total_score = better) ──
  const frByUser  = new Map(fantasyResults.map(f => [f.user_id, f]));
  const leaderboard: TournamentRecapLeaderboardRow[] = members
    .map((m, i) => {
      const fr = frByUser.get(m.user_id);
      return {
        rank:        fr?.rank ?? (members.length + i + 1),
        displayName: m.display_name || 'Player',
        totalScore:  fr?.total_score ?? null,
        isMe:        false,  // filled per-recipient
      };
    })
    .sort((a, b) => {
      if (a.totalScore == null && b.totalScore == null) return 0;
      if (a.totalScore == null) return  1;
      if (b.totalScore == null) return -1;
      return a.totalScore - b.totalScore;
    });

  // ── Season snapshot (skip if league has no season rows) ──
  const seasonStandings: TournamentRecapSeasonRow[] | null = seasonRows.length > 0
    ? [...seasonRows]
        .sort((a, b) => {
          // rank: null sinks; otherwise lower = better
          if (a.rank == null && b.rank == null) return a.total_score - b.total_score;
          if (a.rank == null) return  1;
          if (b.rank == null) return -1;
          return a.rank - b.rank;
        })
        .map(s => ({
          rank:               s.rank,
          displayName:        s.display_name || 'Player',
          totalScore:         s.total_score,
          tournamentsPlayed:  s.tournaments_played,
          isMe:               false,
        }))
    : null;

  // ── Per-recipient render loop ──
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? '';
  const scoreByGolferId = new Map(scoreRows.map(s => [s.golfer_id, s]));
  const pickByUser = new Map(picks.map(p => [p.user_id, p]));

  let emailsSent = 0;

  for (const m of members) {
    if (!m.email) continue;
    if (m.tournament_recap_enabled === false) continue;     // opt-out

    // Best round across the recipient's four golfers (1..4 round
    // values). Lowest strokes-to-par wins; ties broken by earlier
    // round. NULL = round not posted, skipped.
    let bestRound: TournamentRecapBestRound | null = null;
    const pick = pickByUser.get(m.user_id);
    if (pick) {
      const golferIds = [pick.golfer_1_id, pick.golfer_2_id, pick.golfer_3_id, pick.golfer_4_id];
      for (const gid of golferIds) {
        if (!gid) continue;
        const s = scoreByGolferId.get(gid);
        if (!s) continue;
        const rounds: Array<number | null> = [s.round_1, s.round_2, s.round_3, s.round_4];
        for (let i = 0; i < 4; i++) {
          const r = rounds[i];
          if (r == null) continue;
          if (bestRound == null || r < bestRound.score) {
            bestRound = { roundNum: i + 1, score: r, golfer: s.golfer_name };
          }
        }
      }
    }

    // Personalize the leaderboard + season snapshot.
    const myName = m.display_name || 'Player';
    const lbForRecipient = leaderboard.map(r => ({ ...r, isMe: r.displayName === myName }));
    const seasonForRecipient = seasonStandings
      ? seasonStandings.map(r => ({ ...r, isMe: r.displayName === myName }))
      : null;

    const { subject, text, html } = tournamentRecapEmail({
      displayName:     myName,
      leagueName:      league.name,
      leagueSlug:      league.slug,
      tournamentName:  tournament.name,
      leaderboard:     lbForRecipient,
      bestRound,
      seasonStandings: seasonForRecipient,
      siteUrl,
    });

    try {
      const ok = await sendEmail({
        to:      m.email,
        subject,
        text,
        html,
      });
      if (ok) emailsSent++;
      // eslint-disable-next-line no-console
      console.log(
        `[tournament-recap] ${tournament.name} / ${league.name} ` +
        `→ ${m.email} sent=${ok}`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[tournament-recap] send failed for user=${m.user_id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── Update the log row with the actual send count ──
  try {
    await db.updateTable('tournament_recap_log')
      .set({ emails_sent: emailsSent })
      .where('league_id',     '=', league.id)
      .where('tournament_id', '=', tournament.id)
      .execute();
  } catch {
    // Non-critical telemetry — log update failure shouldn't break the run.
  }
}

/**
 * Pretty date label for the email subject + header. Round N happens
 * on (start_date + N-1 days); displayed in the league timezone is
 * a future feature, for now just the tournament's local-ish date.
 */
function formatTournamentRoundDate(
  t: { start_date: string }, roundNum: number,
): string {
  try {
    const d = new Date(t.start_date);
    d.setUTCDate(d.getUTCDate() + (roundNum - 1));
    return d.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
  } catch {
    return `Round ${roundNum}`;
  }
}
