import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/current-user';
import { supabaseAdmin } from '@/lib/supabase';
import Nav from '@/components/layout/Nav';
import type { Metadata } from 'next';

// This page is auth-gated and reads per-user data on every request,
// so static prerender is wrong for it (and also crashes during
// `next build` without Supabase env). Mark dynamic.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'My Leagues' };

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/auth/signin');

  const { data: profile } = await supabaseAdmin
    .from('profiles').select('*').eq('id', user.id).single();

  const { data: memberships } = await supabaseAdmin
    .from('league_members')
    .select('role, leagues(*)')
    .eq('user_id', user.id);

  const leagues = memberships?.map((m: any) => ({ ...m.leagues, role: m.role })) ?? [];

  const { data: upcoming } = await supabaseAdmin
    .from('tournaments')
    .select('*')
    .in('status', ['upcoming', 'active'])
    .order('start_date', { ascending: true })
    .limit(3);

  return (
    <div className="page-shell">
      <Nav userName={profile?.display_name} />

      <div className="t-hero" style={{ padding: '2.5rem 1.5rem' }}>
        <div className="container">
          <p style={{ color: 'rgba(255,255,255,0.55)', fontSize: '0.85rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.4rem' }}>
            Welcome back
          </p>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 'clamp(1.8rem,4vw,2.5rem)', fontWeight: 900, marginBottom: '0.5rem' }}>
            {profile?.display_name ?? 'Golfer'}
          </h1>
          <p style={{ color: 'rgba(255,255,255,0.55)', fontSize: '0.9rem' }}>
            {leagues.length} league{leagues.length !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      <div className="page-content">
        <div className="container">
          {/* Mobile-first: flex-wrap so the sidebar stacks under the leagues
              column on narrow viewports. Was a fixed `1fr 300px` grid that
              broke on phones. (TODO P1 #6.1) */}
          <div style={{
            display: 'flex', flexFlow: 'row wrap', gap: '2rem',
            alignItems: 'flex-start',
          }}>

            {/* Leagues */}
            <div style={{ flex: '1 1 360px', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
                <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.4rem', fontWeight: 700 }}>My Leagues</h2>
                <Link href="/create" className="btn btn-primary btn-sm">+ New League</Link>
              </div>

              {leagues.length === 0 ? (
                <div className="card" style={{ textAlign: 'center', padding: '3rem 2rem' }}>
                  <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>⛳</div>
                  <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.2rem', marginBottom: '0.5rem' }}>No leagues yet</h3>
                  <p style={{ color: 'var(--slate-mid)', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
                    Create a league for your group, or ask someone to send you an invite link.
                  </p>
                  <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
                    <Link href="/create" className="btn btn-primary">Create a League</Link>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
                  {leagues.map((league: any) => (
                    <Link key={league.id} href={`/league/${league.slug}`} style={{ textDecoration: 'none' }}>
                      <div className="card card-hover" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                          <div style={{
                            width: 48, height: 48, borderRadius: 12,
                            background: 'var(--green-deep)', color: 'white',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontFamily: "'Playfair Display', serif", fontSize: '1.3rem', fontWeight: 900,
                          }}>
                            {league.name[0].toUpperCase()}
                          </div>
                          <div>
                            <div style={{ fontWeight: 700, fontSize: '1rem' }}>{league.name}</div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--slate-mid)' }}>
                              fairway.app/league/{league.slug}
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                          {league.role === 'commissioner' && (
                            <span className="badge badge-brass">Commissioner</span>
                          )}
                          <span style={{ color: 'var(--slate-light)', fontSize: '1.2rem' }}>→</span>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>

            {/* Sidebar */}
            <aside style={{ flex: '0 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              {upcoming && upcoming.length > 0 && (
                <div className="card">
                  <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1rem', fontWeight: 700, marginBottom: '1rem' }}>
                    Upcoming Events
                  </h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {upcoming.map((t: any) => (
                      <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.875rem' }}>
                        <div>
                          {t.type === 'major' && (
                            <div style={{ fontSize: '0.65rem', fontWeight: 700, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Major</div>
                          )}
                          <div style={{ fontWeight: t.type === 'major' ? 700 : 500 }}>{t.name}</div>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.2rem' }}>
                          <span style={{ color: 'var(--slate-mid)', fontSize: '0.8rem' }}>
                            {new Date(t.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </span>
                          {t.status === 'active' && <span className="badge badge-live">Live</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="card card-green">
                <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1rem', fontWeight: 700, marginBottom: '0.4rem' }}>
                  Invite Friends
                </h3>
                <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.82rem', marginBottom: '1rem', lineHeight: 1.55 }}>
                  Create a league first, then share the invite link. Friends click, sign up, and they&rsquo;re in.
                </p>
                <Link href="/create" className="btn btn-brass btn-sm btn-full">
                  Create League →
                </Link>
              </div>

              {/* Reminder preferences entry point */}
              <div className="card">
                <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1rem', fontWeight: 700, marginBottom: '0.4rem' }}>
                  🔔 Pick Reminders
                </h3>
                <p style={{ color: 'var(--slate-mid)', fontSize: '0.82rem', marginBottom: '1rem' }}>
                  Get a nudge before picks lock. Off by default — opt in per channel.
                </p>
                <Link href="/settings" className="btn btn-outline btn-sm btn-full">
                  Manage preferences →
                </Link>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
