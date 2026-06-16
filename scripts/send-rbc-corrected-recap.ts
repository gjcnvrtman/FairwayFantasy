// One-shot recovery: send a CORRECTED tournament recap to every member
// of every league that covers RBC Canadian Open (tournament id
// 20212e6f-ad69-46a5-9e78-0fab8179407f).
//
// Background:
//   - Sunday 2026-06-14 09:40 CDT, the score sync incorrectly flipped
//     the tournament to status='complete' (linescores-length heuristic
//     misfired during the rain-delayed R3/R4 overlap).
//   - The tournament_recap email fired at that instant with R4=0 for
//     every golfer, mailing 26 recipients across 3 leagues a wrong
//     final standings ("winner" was Jackson Suber at -13; actual
//     winner was Bud Cauley at -17).
//   - The R4 daily-scorecard email at 7pm CDT fired with the same
//     stale data.
//   - The DB was re-synced on 2026-06-16 06:03 CDT so scores +
//     fantasy_results now reflect ESPN's actual final.
//
// This script reads the corrected data and re-sends the recap with
// `corrected: true`, which renders a banner + bolds all updated
// totals. Per-user bestRound is recomputed against the corrected
// per-round scores too.
//
// Mirrors sendTournamentRecapForLeague in src/lib/sync.ts. We don't
// reuse that function because it has a tournament_recap_log dedup
// reserve that intentionally blocks re-sends.
//
// Usage (on prod, where the .env.local lives next to the running app):
//   cd /opt/fairway-fantasy && npx tsx scripts/send-rbc-corrected-recap.ts
//
// Optional env vars:
//   ONLY_LEAGUE_SLUG  — restrict to a single league (e.g. gunga-galunga-gang).
//                        Used to ship corrections piecemeal when other leagues'
//                        commissioners want to handle their own notification.
//   DRY_RUN=1         — print recipients without sending.
//
// Idempotency: the script does NOT touch tournament_recap_log. Re-
// running it would re-send every email. Run once.

import { db } from '../src/lib/db';
import {
  sendEmail,
  tournamentRecapEmail,
  type TournamentRecapLeaderboardRow,
  type TournamentRecapBestRound,
  type TournamentRecapSeasonRow,
} from '../src/lib/email';

const TOURNAMENT_ID = '20212e6f-ad69-46a5-9e78-0fab8179407f';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://fairway.golf-czar.com';
const ONLY_LEAGUE_SLUG = process.env.ONLY_LEAGUE_SLUG ?? null;
const DRY_RUN = process.env.DRY_RUN === '1';

async function main() {
  if (DRY_RUN) console.log('*** DRY_RUN=1 — printing recipients without sending ***\n');
  if (ONLY_LEAGUE_SLUG) console.log(`*** Restricted to league slug: ${ONLY_LEAGUE_SLUG} ***\n`);

  const tournament = await db.selectFrom('tournaments')
    .select(['id', 'name', 'start_date', 'end_date'])
    .where('id', '=', TOURNAMENT_ID)
    .executeTakeFirstOrThrow();

  // Same league-window overlap as sendTournamentRecapForLeague.
  let leaguesQuery = db.selectFrom('leagues')
    .select(['id', 'name', 'slug'])
    .where(eb => eb.or([
      eb('start_date', 'is', null),
      eb('start_date', '<=', tournament.end_date),
    ]))
    .where(eb => eb.or([
      eb('end_date', 'is', null),
      eb('end_date', '>=', tournament.start_date),
    ]));
  if (ONLY_LEAGUE_SLUG) leaguesQuery = leaguesQuery.where('slug', '=', ONLY_LEAGUE_SLUG);
  const leagues = await leaguesQuery.execute();

  console.log(`Found ${leagues.length} league(s) covering ${tournament.name}.`);

  for (const league of leagues) {
    console.log(`\n=== ${league.name} (${league.slug}) ===`);
    const result = await sendForLeague(tournament, league);
    console.log(`Sent ${result.sent}/${result.attempted} (${result.skipped} skipped, ${result.failed} failed)`);
  }
}

async function sendForLeague(
  tournament: { id: string; name: string; start_date: string; end_date: string },
  league:     { id: string; name: string; slug: string },
) {
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

  if (members.length === 0) {
    return { sent: 0, attempted: 0, skipped: 0, failed: 0 };
  }

  // Final-standings rows (sorted; lower total_score = better)
  const frByUser = new Map(fantasyResults.map(f => [f.user_id, f]));
  const leaderboard: TournamentRecapLeaderboardRow[] = members
    .map((m, i) => {
      const fr = frByUser.get(m.user_id);
      return {
        rank:        fr?.rank ?? (members.length + i + 1),
        displayName: m.display_name || 'Player',
        totalScore:  fr?.total_score ?? null,
        isMe:        false,
      };
    })
    .sort((a, b) => {
      if (a.totalScore == null && b.totalScore == null) return 0;
      if (a.totalScore == null) return  1;
      if (b.totalScore == null) return -1;
      return a.totalScore - b.totalScore;
    });

  const seasonStandings: TournamentRecapSeasonRow[] | null = seasonRows.length > 0
    ? [...seasonRows]
        .sort((a, b) => {
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

  const scoreByGolferId = new Map(scoreRows.map(s => [s.golfer_id, s]));
  const pickByUser      = new Map(picks.map(p => [p.user_id, p]));

  let sent = 0, attempted = 0, skipped = 0, failed = 0;

  for (const m of members) {
    if (!m.email) { skipped++; continue; }
    // Per-user opt-out still respected on the re-send.
    if (m.tournament_recap_enabled === false) { skipped++; continue; }
    attempted++;

    // Per-user best round, recomputed against the corrected scores.
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
      siteUrl:         SITE_URL,
      corrected:       true,
    });

    if (DRY_RUN) {
      sent++;
      console.log(`  ~ ${m.email} (DRY_RUN, not sent)`);
      continue;
    }
    try {
      const ok = await sendEmail({ to: m.email, subject, text, html });
      if (ok) {
        sent++;
        console.log(`  ✓ ${m.email}`);
      } else {
        failed++;
        console.log(`  ✗ ${m.email} (sendEmail returned false — check SMTP config)`);
      }
    } catch (err) {
      failed++;
      console.log(`  ✗ ${m.email} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { sent, attempted, skipped, failed };
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
  });
