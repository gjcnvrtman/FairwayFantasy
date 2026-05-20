import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import { getLeagueBySlug, getLeagueMembers } from '@/lib/db/queries';
import Nav from '@/components/layout/Nav';
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

  // All tournaments, chronological. Pre-2026-05-19 this was
  // `.orderBy('start_date', 'desc').limit(10)` — descending hid
  // upcoming events past the 10th and the limit chopped off the
  // tail of the season. Commissioner needs the full list so
  // pick-deadline overrides can be set for ANY upcoming event,
  // not just the next ten.
  const tournaments = await db.selectFrom('tournaments')
    .selectAll()
    .orderBy('start_date', 'asc')
    .execute();

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

  return (
    <div className="page-shell">
      <Nav leagueSlug={params.slug} leagueName={league.name} userName={profile?.display_name} />

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
            viewerRole={viewerRole}
            inviteUrl={`${process.env.NEXT_PUBLIC_SITE_URL ?? ''}/join/${league.slug}/${league.invite_code}`}
          />
        </div>
      </div>
    </div>
  );
}
