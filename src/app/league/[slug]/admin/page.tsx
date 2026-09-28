import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import { getLeagueBySlug, getLeagueMembers } from '@/lib/db/queries';
import { resolveSetupStatus, nextAutoLock } from '@/lib/league-setup';
import { loadSeasonBets } from '@/lib/db/season-data';
import AceAdjustmentsCard from './AceAdjustmentsCard';
import Nav from '@/components/layout/Nav';
import { hasSeasonBets, seasonBetConfigFromLeague } from '@/lib/season-bets';
import AdminPanel from './AdminPanel';
import type { Metadata } from 'next';

interface Props { params: { slug: string } }
export const metadata: Metadata = { title: 'Admin' };

export default async function AdminPage({ params }: Props) {
  const user = await getCurrentUser();
  if (!user) redirect(`/auth/signin`);

  const league = await getLeagueBySlug(params.slug);
  if (!league) notFound();

  // Commissioner OR co-commissioner. Co's see the same panel; the
  // AdminPanel itself hides commissioner-only sections (Danger Zone,
  // role management, league settings) when `viewerRole !== 'commissioner'`.
  const membership = await db.selectFrom('league_members')
    .select('role')
    .where('league_id', '=', league.id)
    .where('user_id',   '=', user.id)
    .executeTakeFirst();
  if (!membership
      || (membership.role !== 'commissioner'
          && membership.role !== 'co_commissioner')) {
    redirect(`/league/${params.slug}`);
  }
  const viewerRole = membership.role as 'commissioner' | 'co_commissioner';

  const profile = await db.selectFrom('profiles')
    .select('display_name')
    .where('id', '=', user.id)
    .executeTakeFirst();

  const members = await getLeagueMembers(league.id);

  // All non-hidden tournaments, chronological. Pre-2026-05-19 this
  // was `.orderBy('start_date', 'desc').limit(10)` — descending hid
  // upcoming events past the 10th and the limit chopped off the
  // tail of the season. Commissioner needs the full list so
  // pick-deadline overrides can be set for ANY upcoming event,
  // not just the next ten. Migration 022 added tournaments.hidden;
  // hidden rows are dropped everywhere in this panel.
  const tournaments = await db.selectFrom('tournaments')
    .selectAll()
    .where('hidden', '=', false)
    .orderBy('start_date', 'asc')
    .execute();

  // IDs currently in this league's schedule (migration 022).
  // Drives the Schedule admin section — anything in this set is
  // "in the league schedule and can be removed"; anything NOT in
  // this set (but non-hidden + in the league window) is "available
  // to add." Passed as string[] to keep the client prop plain.
  const scheduleRows = await db.selectFrom('league_tournaments')
    .select('tournament_id')
    .where('league_id', '=', league.id)
    .execute();
  const scheduleIds = scheduleRows.map(r => r.tournament_id);

  const activeTournament = await db.selectFrom('tournaments')
    .selectAll()
    .where('status', 'in', ['active', 'cut_made'])
    .limit(1)
    .executeTakeFirst() ?? null;

  // Tournament-ids this league actually submitted complete picks for.
  // Drives the "Tournament Status" table's filter — Greg only wants
  // to see prior events where bets were on the line (i.e. this league
  // participated), not the firehose of every PGA tournament ever.
  // A pick is "complete" when all four golfer_N_id columns are set;
  // partial drafts don't count as participation.
  const pickedRows = await db.selectFrom('picks')
    .select('tournament_id')
    .distinct()
    .where('league_id', '=', league.id)
    .where('golfer_1_id', 'is not', null)
    .where('golfer_2_id', 'is not', null)
    .where('golfer_3_id', 'is not', null)
    .where('golfer_4_id', 'is not', null)
    .execute();
  const tournamentIdsWithPicks = pickedRows.map(r => r.tournament_id);

  // Per-tournament bet overrides for this league (migration 010).
  // NULL row → AdminPanel resolves to league.weekly_bet_amount.
  const betRows = await db.selectFrom('league_tournament_bets')
    .select(['tournament_id', 'bet_amount'])
    .where('league_id', '=', league.id)
    .execute();
  const tournamentBets: Record<string, string> = {};
  for (const r of betRows) {
    tournamentBets[r.tournament_id] = r.bet_amount;
  }

  // Setup lifecycle (migration 025). Resolving applies auto-lock, so
  // the panel never shows editable rules past the first pick deadline.
  const setupStatus = await resolveSetupStatus(league);
  const autoLock = setupStatus === 'setup' ? await nextAutoLock(league.id) : null;

  // Hole-in-one corrections (migration 027) — only when the league has
  // an ace bounty. Candidates = golfers on a team in each started event.
  let aceCard: React.ReactNode = null;
  if (league.bet_ace_bounty != null) {
    const seasonBets = await loadSeasonBets(league);
    const started = tournaments.filter(t => scheduleIds.includes(t.id) && t.status !== 'upcoming');
    const startedIds = started.map(t => t.id);
    const pickRows = startedIds.length === 0 ? [] : await db.selectFrom('picks')
      .select(['tournament_id', 'golfer_1_id', 'golfer_2_id', 'golfer_3_id',
               'golfer_4_id', 'golfer_5_id', 'golfer_6_id'])
      .where('league_id', '=', league.id)
      .where('tournament_id', 'in', startedIds)
      .execute();
    const golferIds = [...new Set(pickRows.flatMap(p =>
      [p.golfer_1_id, p.golfer_2_id, p.golfer_3_id, p.golfer_4_id, p.golfer_5_id, p.golfer_6_id]
        .filter((id): id is string => !!id)))];
    const names = golferIds.length === 0 ? [] : await db.selectFrom('golfers')
      .select(['id', 'name']).where('id', 'in', golferIds).execute();
    const nameOf = new Map(names.map(g => [g.id, g.name]));
    const tName = new Map(tournaments.map(t => [t.id, t.name]));
    const candidates = started.map(t => {
      const ids = new Set(pickRows.filter(p => p.tournament_id === t.id).flatMap(p =>
        [p.golfer_1_id, p.golfer_2_id, p.golfer_3_id, p.golfer_4_id, p.golfer_5_id, p.golfer_6_id]
          .filter((id): id is string => !!id)));
      return {
        tournamentId: t.id, tournamentName: t.name,
        golfers: [...ids].map(id => ({ id, name: nameOf.get(id) ?? 'Unknown' }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    }).reverse();   // most recent first
    aceCard = (
      <AceAdjustmentsCard
        slug={league.slug}
        aces={seasonBets?.aces ?? []}
        voided={(seasonBets?.voidedAces ?? []).map(v => ({
          ...v,
          tournamentName: tName.get(v.tournamentId) ?? 'Tournament',
          golferName: nameOf.get(v.golferId) ?? 'Golfer',
        }))}
        candidates={candidates}
      />
    );
  }

  return (
    <div className="page-shell">
      <Nav leagueSlug={params.slug} leagueName={league.name} userName={profile?.display_name}
           showSeasons={hasSeasonBets(seasonBetConfigFromLeague(league))} />

      <div className="t-hero" style={{ padding: '2.5rem 1.5rem' }}>
        <div className="container">
          <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '0.4rem' }}>
            Commissioner Panel
          </p>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 'clamp(1.8rem,4vw,2.5rem)', fontWeight: 900 }}>
            {league.name} Admin
          </h1>
        </div>
      </div>

      <div className="page-content">
        <div className="container">
          <AdminPanel
            league={league}
            members={members}
            tournaments={tournaments}
            activeTournament={activeTournament}
            tournamentIdsWithPicks={tournamentIdsWithPicks}
            tournamentBets={tournamentBets}
            scheduleIds={scheduleIds}
            setupStatus={setupStatus}
            autoLock={autoLock ? {
              tournamentName: autoLock.tournamentName,
              at: autoLock.at.toISOString(),
            } : null}
            viewerRole={viewerRole}
            extraSections={aceCard}
            inviteUrl={`${process.env.NEXT_PUBLIC_SITE_URL ?? ''}/join/${league.slug}/${league.invite_code}`}
          />
        </div>
      </div>
    </div>
  );
}
