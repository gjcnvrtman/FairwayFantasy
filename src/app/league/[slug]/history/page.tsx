import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/current-user';
import { supabaseAdmin, getLeagueBySlug } from '@/lib/supabase';
import { formatScore } from '@/lib/scoring';
import Nav from '@/components/layout/Nav';
import type { Metadata } from 'next';

interface Props { params: { slug: string } }
export const metadata: Metadata = { title: 'History' };

export default async function HistoryPage({ params }: Props) {
  const user = await getCurrentUser();
  if (!user) redirect(`/auth/signin?redirect=/league/${params.slug}/history`);

  const league = await getLeagueBySlug(params.slug);
  if (!league) notFound();

  const { data: membership } = await supabaseAdmin
    .from('league_members').select('role').eq('league_id', league.id).eq('user_id', user.id).single();
  if (!membership) redirect(`/join/${params.slug}/${league.invite_code}`);

  const { data: profile } = await supabaseAdmin
    .from('profiles').select('display_name').eq('id', user.id).single();

  // Get all completed tournaments with results for this league
  const { data: completedTournaments } = await supabaseAdmin
    .from('tournaments')
    .select('*')
    .eq('status', 'complete')
    .order('start_date', { ascending: false });

  // For each tournament, get the fantasy results for this league
  const tournamentResults = await Promise.all(
    (completedTournaments ?? []).map(async (t: any) => {
      const { data: results } = await supabaseAdmin
        .from('fantasy_results')
        .select('*, profile:profiles(display_name)')
        .eq('league_id', league.id)
        .eq('tournament_id', t.id)
        .order('rank', { ascending: true });
      return { tournament: t, results: results ?? [] };
    })
  );

  const withResults = tournamentResults.filter(t => t.results.length > 0);

  return (
    <div className="page-shell">
      <Nav leagueSlug={params.slug} leagueName={league.name} userName={profile?.display_name} />

      <div className="t-hero" style={{ padding: '2.5rem 1.5rem' }}>
        <div className="container">
          <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '0.4rem' }}>
            {league.name}
          </p>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 'clamp(1.8rem,4vw,2.5rem)', fontWeight: 900 }}>
            Tournament History
          </h1>
          <p style={{ color: 'rgba(255,255,255,0.5)', marginTop: '0.3rem', fontSize: '0.875rem' }}>
            {withResults.length} completed event{withResults.length !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      <div className="page-content">
        <div className="container">
          {withResults.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', padding: '4rem 2rem' }}>
              <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📋</div>
              <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.3rem', marginBottom: '0.5rem' }}>No history yet</h3>
              <p style={{ color: 'var(--slate-mid)' }}>Completed tournament results will appear here.</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
              {withResults.map(({ tournament: t, results }) => {
                const winner = results[0];
                return (
                  <div key={t.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                    {/* Tournament header */}
                    <div style={{
                      background: t.type === 'major'
                        ? 'linear-gradient(135deg, #1a2f1e 0%, #2d5a34 100%)'
                        : 'var(--green-deep)',
                      color: 'white', padding: '1.25rem 1.5rem',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem',
                    }}>
                      <div>
                        {t.type === 'major' && (
                          <div className="major-badge" style={{ marginBottom: '0.4rem' }}>🏆 Major</div>
                        )}
                        <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.2rem', fontWeight: 700 }}>{t.name}</h3>
                        <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.8rem', marginTop: '0.2rem' }}>
                          {new Date(t.start_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                          {t.course_name && ` · ${t.course_name}`}
                          {t.cut_score !== null && ` · Cut: ${formatScore(t.cut_score)}`}
                        </p>
                      </div>
                      {winner && (
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Winner</div>
                          <div style={{ fontWeight: 700, color: '#d4b06a' }}>🏆 {winner.profile?.display_name}</div>
                          <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.6)' }}>{formatScore(winner.total_score)}</div>
                        </div>
                      )}
                    </div>

                    {/* Results table */}
                    <table className="lb-table">
                      <thead>
                        <tr>
                          <th style={{ width: 48 }}>#</th>
                          <th>Player</th>
                          <th className="hide-mobile">Golfer 1</th>
                          <th className="hide-mobile">Golfer 2</th>
                          <th className="hide-mobile">Golfer 3</th>
                          <th className="hide-mobile">Golfer 4</th>
                          <th>Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.map((r: any, i: number) => (
                          <tr key={r.user_id} className={`rank-${i + 1}`}>
                            <td><span className="rank-num">{r.rank ?? i + 1}</span></td>
                            <td>
                              <strong>{r.profile?.display_name}</strong>
                              {r.user_id === user.id && <span style={{ marginLeft: '0.4rem', fontSize: '0.72rem', color: 'var(--brass)' }}>← you</span>}
                            </td>
                            {[r.golfer_1_score, r.golfer_2_score, r.golfer_3_score, r.golfer_4_score].map((s: number | null, si: number) => (
                              <td key={si} className="hide-mobile">
                                <span
                                  className={
                                    r.counting_golfers?.includes(si + 1)
                                      ? (s < 0 ? 'score-under' : s > 0 ? 'score-over' : 'score-even')
                                      : ''
                                  }
                                  style={{ opacity: r.counting_golfers?.includes(si + 1) ? 1 : 0.35 }}
                                >
                                  {formatScore(s)}
                                </span>
                              </td>
                            ))}
                            <td>
                              <strong className={r.total_score < 0 ? 'score-under' : r.total_score > 0 ? 'score-over' : 'score-even'}>
                                {formatScore(r.total_score)}
                              </strong>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
