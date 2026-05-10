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

  // Only commissioners
  const membership = await db.selectFrom('league_members')
    .select('role')
    .where('league_id', '=', league.id)
    .where('user_id',   '=', user.id)
    .executeTakeFirst();
  if (!membership || membership.role !== 'commissioner') redirect(`/league/${params.slug}`);

  const profile = await db.selectFrom('profiles')
    .select('display_name')
    .where('id', '=', user.id)
    .executeTakeFirst();

  const members = await getLeagueMembers(league.id);

  const tournaments = await db.selectFrom('tournaments')
    .selectAll()
    .orderBy('start_date', 'desc')
    .limit(10)
    .execute();

  const activeTournament = await db.selectFrom('tournaments')
    .selectAll()
    .where('status', 'in', ['active', 'cut_made'])
    .limit(1)
    .executeTakeFirst() ?? null;

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
            inviteUrl={`${process.env.NEXT_PUBLIC_SITE_URL ?? ''}/join/${league.slug}/${league.invite_code}`}
          />
        </div>
      </div>
    </div>
  );
}
