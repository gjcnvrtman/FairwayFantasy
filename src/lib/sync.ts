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
import { applyFantasyRules, computeLeagueResults } from './scoring';
import { dispatchReminder, fieldPublishedMessage } from './notifier';
import { effectivePickDeadline } from './pick-deadline';
import type { Channel, ReminderTask } from './reminders';
import type { Score, Pick, FantasyResult } from '@/types';

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
  end_date:       string;
}): Promise<SyncResult> {
  const { espn_event_id, id, cut_score, end_date } = tournament;
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
  // When ESPN doesn't supply cutLine, fall back to PGA Tour's
  // standard top-65-and-ties rule applied to all 36-hole totals.
  // ESPN's value always wins when present. Major variations (Masters
  // top-50+10, USGA/R&A/PGA-Championship top-60-70+ties) are not
  // modeled — see TODO.md.
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
      // PGA Tour standard: top 65 + ties. Sort ascending (low = good
      // in golf); the 65th-best total IS the cut score, and anyone
      // tied at or better than it makes the cut. Fields under 65 →
      // everyone makes the cut, which the Math.min clamp delivers.
      totals.sort((a, b) => a - b);
      effectiveCut = totals[Math.min(64, totals.length - 1)];
    }
  }

  // Completion inference (added 2026-05-20).
  //
  // ESPN's `/pga/scoreboard` fallback never reports `status='final'`
  // — it stays `STATUS_IN_PROGRESS` even days after the trophy
  // ceremony. The weekly rankings-timer maintenance sweep eventually
  // flips stuck rows to complete (Monday 06:00), but the gap leaves
  // the money card blank for ~14 hours every Sunday night.
  //
  // Linescore signal: normalizeScoreboardCompetitor drops un-played
  // future rounds from `linescores`, so a cut survivor (made it past
  // R2) who has `linescores.length === 4` has finished all four
  // rounds. When EVERY cut survivor is at length 4 AND the
  // tournament's end_date is in the past, the tournament is over —
  // regardless of what ESPN's text status says.
  //
  // Edge cases:
  //   * Mid-Sunday (some R4s in progress): `every` fails, stays
  //     in `cut_made`. Correct.
  //   * No cut survivors yet (Round 1/2): the >=3 guard skips,
  //     `every` returns true for an empty list but the
  //     `survivors.length > 0` guard prevents the flip. Stays
  //     in `active`/`cut_made`. Correct.
  //   * Weather-shortened tournament (54 holes only): survivors
  //     end at length 3, never 4 → linescore signal never fires.
  //     The Monday maintenance sweep still handles it within a week.
  const tournamentEnded = new Date(end_date).getTime() < Date.now();
  let completionByLinescore = false;
  if (tournamentEnded) {
    const survivors = competitors.filter(c => (c.linescores?.length ?? 0) >= 3);
    completionByLinescore = survivors.length > 0
      && survivors.every(c => (c.linescores?.length ?? 0) === 4);
  }

  const newStatus = status.toLowerCase().includes('final') || completionByLinescore ? 'complete'
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
      return { ok: true, results: [], touched: 0 };
    }

    const results: FieldSyncResult[] = [];
    for (const t of candidates) {
      results.push(await checkAndPublishField(t));
    }
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

  return {
    tournament:  name,
    espn_event_id,
    competitors: competitors.length,
    published:   true,
  };
}

/**
 * Build + dispatch "field is set" notifications for every member of
 * every league whose date window includes this tournament. Honors
 * `reminder_preferences.*_enabled` per channel (default: email on,
 * sms/push off). Best-effort — errors per recipient are logged but
 * don't fail the parent sync run.
 */
async function notifyFieldPublished(args: {
  tournamentId:   string;
  tournamentName: string;
}): Promise<void> {
  const { tournamentId, tournamentName } = args;
  try {
    // Hydrate the tournament row for the message template.
    const t = await db.selectFrom('tournaments')
      .select(['id', 'pick_deadline', 'pick_deadline_override'])
      .where('id', '=', tournamentId)
      .executeTakeFirst();
    if (!t) return;
    const pickDeadline = effectivePickDeadline(t);

    // Notify members of EVERY league. We intentionally don't filter
    // by `leagues.start_date`/`end_date` (the per-league date window
    // used elsewhere to scope tournaments): there's schema drift on
    // those columns vs the canonical init script, and the cost of
    // a broader audience is minimal — a member of a league whose
    // window has already closed simply gets a heads-up about a
    // tournament their league isn't scoring. Worth the resilience
    // over a stricter filter that silently no-ops when the columns
    // aren't there.
    const leagues = await db.selectFrom('leagues')
      .select(['id', 'slug'])
      .execute();
    if (leagues.length === 0) return;

    const members = await db.selectFrom('league_members')
      .select(['user_id', 'league_id'])
      .execute();
    if (members.length === 0) return;

    const userIds = Array.from(new Set(members.map(m => m.user_id)));
    const [profiles, prefsRows] = await Promise.all([
      db.selectFrom('profiles')
        .select(['id', 'email', 'display_name'])
        .where('id', 'in', userIds)
        .execute(),
      db.selectFrom('reminder_preferences')
        .selectAll()
        .where('user_id', 'in', userIds)
        .execute(),
    ]);
    const profileById = new Map(profiles.map(p => [p.id, p]));
    const prefsByUser = new Map(prefsRows.map(r => [r.user_id, r]));
    const slugByLeague = new Map(leagues.map(l => [l.id, l.slug]));

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? '';

    for (const m of members) {
      const profile = profileById.get(m.user_id);
      if (!profile) continue;
      const prefs = prefsByUser.get(m.user_id);
      // Default-on for email when no prefs row exists (migration 004
      // back-filled prefs rows for existing users; safe fallback for
      // any user created before that ran).
      const emailOn = prefs ? prefs.email_enabled : true;
      const smsOn   = prefs ? prefs.sms_enabled   : false;
      const pushOn  = prefs ? prefs.push_enabled  : false;

      // Per-channel resolution: email uses prefs.email_addr override
      // when set, else falls back to the profile email. Skip channels
      // with no destination.
      const channels: Array<{ ch: Channel; dest: string | null }> = [];
      if (emailOn) channels.push({ ch: 'email', dest: prefs?.email_addr ?? profile.email ?? null });
      if (smsOn)   channels.push({ ch: 'sms',   dest: prefs?.phone_e164 ?? null });
      if (pushOn)  channels.push({ ch: 'push',  dest: prefs?.push_token ?? null });

      const picksUrl = `${siteUrl}/league/${slugByLeague.get(m.league_id) ?? ''}/picks`;

      for (const { ch, dest } of channels) {
        if (!dest) continue;
        const task: ReminderTask = {
          user_id:       m.user_id,
          league_id:     m.league_id,
          tournament_id: tournamentId,
          channel:       ch,
          destination:   dest,
        };
        try {
          const result = await dispatchReminder(task, t2 =>
            fieldPublishedMessage({
              task:           t2,
              tournamentName,
              pickDeadline,
              picksUrl,
            }),
          );
          // eslint-disable-next-line no-console
          console.log(
            `[field-publish] ${tournamentName} → user=${m.user_id} ch=${ch} status=${result.status}` +
              (result.error ? ` err=${result.error}` : ''),
          );
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            `[field-publish] dispatch failed for user=${m.user_id} ch=${ch}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  } catch (err) {
    // Never fail the parent sync run because of a notification glitch.
    // eslint-disable-next-line no-console
    console.error('[field-publish] notify pass failed:', err);
  }
}
