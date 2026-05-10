import { createServerSupabaseClient } from '@/lib/supabase-server';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { supabaseAdmin, getLeagueBySlug, getLeagueMembers } from '@/lib/supabase';
import Nav from '@/components/layout/Nav';
import AdminPanel from './AdminPanel';
import type { Metadata } from 'next';

interface Props { params: { slug: string } }
export const metadata: Metadata = { title: 'Admin' };

export default async function AdminPage({ params }: Props) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/auth/signin`);

  const league = await getLeagueBySlug(params.slug);
  if (!league) notFound();

  // Only commissioners
  const { data: membership } = await supabaseAdmin
    .from('league_members').select('role').eq('league_id', league.id).eq('user_id', user.id).single();
  if (!membership || membership.role !== 'commissioner') redirect(`/league/${params.slug}`);

  const { data: profile } = await supabaseAdmin
    .from('profiles').select('display_name').eq('id', user.id).single();

  const members = await getLeagueMembers(league.id);

  const { data: tournaments } = await supabaseAdmin
    .from('tournaments').select('*').order('start_date', { ascending: false }).limit(10);

  const { data: activeTournament } = await supabaseAdmin
    .from('tournaments').select('*').in('status', ['active', 'cut_made']).limit(1).single();

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
            tournaments={tournaments ?? []}
            activeTournament={activeTournament ?? null}
            inviteUrl={`${process.env.NEXT_PUBLIC_SITE_URL ?? ''}/join/${league.slug}/${league.invite_code}`}
          />
        </div>
      </div>
    </div>
  );
}
