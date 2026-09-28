// /league/[slug]/seasons — season bets (migration 027).
//
// Per season: its tournaments, running standings for each enabled
// cumulative bet, and the payout once every event in it is complete.
// Plus the hole-in-one log for the ace bounty.

import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import { getLeagueBySlug } from '@/lib/db/queries';
import { loadSeasonBets } from '@/lib/db/season-data';
import { BET_LABELS } from '@/lib/season-bets';
import { formatScore } from '@/lib/scoring';
import { formatMoney } from '@/lib/money';
import Nav from '@/components/layout/Nav';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Seasons' };

interface Props { params: { slug: string } }

const STATUS_BADGE: Record<string, string> = {
  complete: 'badge-green', active: 'badge-live', cut_made: 'badge-blue', upcoming: 'badge-gray',
};

export default async function SeasonsPage({ params }: Props) {
  const user = await getCurrentUser();
  if (!user) redirect(`/auth/signin?redirect=/league/${params.slug}/seasons`);

  const league = await getLeagueBySlug(params.slug);
  if (!league) notFound();

  const membership = await db.selectFrom('league_members')
    .select('role')
    .where('league_id', '=', league.id)
    .where('user_id', '=', user.id)
    .executeTakeFirst();
  if (!membership) redirect(`/join/${params.slug}/${league.invite_code}`);

  const [data, people] = await Promise.all([
    loadSeasonBets(league),
    db.selectFrom('league_members')
      .innerJoin('profiles', 'profiles.id', 'league_members.user_id')
      .select(['league_members.user_id', 'profiles.display_name'])
      .where('league_members.league_id', '=', league.id)
      .execute(),
  ]);
  const nameOf = new Map(people.map(p => [p.user_id, p.display_name || 'Player']));
  const me = (uid: string) => uid === user.id;
  const viewer = people.find(p => p.user_id === user.id);

  const heading = (
    <div className="t-hero" style={{ padding: '2.25rem 1.5rem' }}>
      <div className="container">
        <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.78rem', fontWeight: 700,
                    textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '0.4rem' }}>
          {league.name}
        </p>
        <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 'clamp(1.8rem,4vw,2.5rem)', fontWeight: 900 }}>
          Season Bets
        </h1>
      </div>
    </div>
  );

  if (!data) {
    return (
      <div className="page-shell">
        <Nav leagueSlug={params.slug} leagueName={league.name} userName={viewer?.display_name} />
        {heading}
        <div className="page-content"><div className="container">
          <div className="card" style={{ textAlign: 'center', padding: '3rem 1.5rem', color: 'var(--slate-mid)' }}>
            This league doesn&rsquo;t have season bets.{' '}
            <Link href={`/league/${params.slug}`} style={{ color: 'var(--green-mid)', fontWeight: 600 }}>
              Back to leaderboard
            </Link>
          </div>
        </div></div>
      </div>
    );
  }

  const { cfg, seasons, aces } = data;
  const moneyCls = (v: number) => (v > 0 ? 'score-under' : v < 0 ? 'score-over' : 'score-even');

  return (
    <div className="page-shell">
      <Nav leagueSlug={params.slug} leagueName={league.name} userName={viewer?.display_name} showSeasons />
      {heading}
      <div className="page-content">
        <div className="container" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

          {/* ── Rules summary ── */}
          <section className="card" style={{ fontSize: '0.88rem' }}>
            <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.5rem' }}>
              How these bets work
            </h2>
            <ul style={{ paddingLeft: '1.1rem', lineHeight: 1.7, color: 'var(--slate)', margin: 0 }}>
              {(['team', 'topTier', 'darkHorse'] as const).map(b => cfg.amounts[b] != null && (
                <li key={b}>
                  <strong>{BET_LABELS[b]}</strong>: every player bets{' '}
                  <strong>${cfg.amounts[b]!.toFixed(2)}</strong> each season; the lowest cumulative score
                  takes the whole pot (ties split it).
                </li>
              ))}
              {cfg.aceBounty != null && (
                <li>
                  <strong>Hole-in-one</strong>: when a golfer on your team makes an ace, every other player pays
                  you <strong>${cfg.aceBounty.toFixed(2)}</strong>.
                </li>
              )}
              <li>
                Scores are to par; missed-cut golfers count at their score through the cut
                {cfg.addPenalties ? ', plus the missed-cut penalty (and the missed-deadline penalty on the team bet)' : ''}.
                Payouts settle when every tournament in the season is final.
              </li>
            </ul>
          </section>

          {/* ── Seasons ── */}
          {seasons.map(s => {
            const played = s.tournaments.filter(t => t.status !== 'upcoming').length;
            const statusLabel = s.complete ? 'Final' : played === 0 ? 'Not started' : `In progress · ${played} of ${s.tournaments.length}`;
            return (
              <section key={s.season} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <header style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--cream-dark)',
                                 display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.2rem', fontWeight: 700, margin: 0 }}>
                    Season {s.season}
                  </h2>
                  <span className={`badge ${s.complete ? 'badge-green' : played ? 'badge-blue' : 'badge-gray'}`}>{statusLabel}</span>
                </header>

                <div style={{ padding: '0.75rem 1.25rem', display: 'flex', flexWrap: 'wrap', gap: '0.4rem',
                              borderBottom: '1px solid var(--cream-dark)' }}>
                  {s.tournaments.map(t => (
                    <span key={t.id} className={`badge ${STATUS_BADGE[t.status] ?? 'badge-gray'}`} title={t.status}>
                      {t.name}
                    </span>
                  ))}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
                  {s.bets.map(b => (
                    <div key={b.bet} style={{ padding: '0.9rem 1.25rem', borderRight: '1px solid var(--cream-dark)' }}>
                      <p style={{ fontWeight: 700, fontSize: '0.88rem', margin: '0 0 0.5rem' }}>
                        {BET_LABELS[b.bet]}{' '}
                        <span style={{ color: 'var(--slate-mid)', fontWeight: 500 }}>
                          · ${b.amount.toFixed(2)} each · pot ${b.pot.toFixed(2)}
                        </span>
                      </p>
                      {played === 0 ? (
                        <p style={{ fontSize: '0.82rem', color: 'var(--slate-mid)', margin: 0 }}>No scores yet.</p>
                      ) : (
                        <table style={{ width: '100%', fontSize: '0.84rem', borderCollapse: 'collapse' }}>
                          <tbody>
                            {b.standings.map(r => (
                              <tr key={r.userId} style={{ fontWeight: me(r.userId) ? 700 : 400 }}>
                                <td style={{ width: 28, color: 'var(--brass)', fontWeight: 700 }}>{r.rank}</td>
                                <td style={{ padding: '0.2rem 0' }}>{nameOf.get(r.userId) ?? 'Player'}</td>
                                <td style={{ textAlign: 'right' }}>
                                  <span className={r.total < 0 ? 'score-under' : r.total > 0 ? 'score-over' : 'score-even'}>
                                    {formatScore(r.total)}
                                  </span>
                                </td>
                                {b.deltas && (
                                  <td style={{ textAlign: 'right', width: 80 }}>
                                    <span className={moneyCls(b.deltas.get(r.userId) ?? 0)}>
                                      {formatMoney(b.deltas.get(r.userId) ?? 0)}
                                    </span>
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            );
          })}

          {/* ── Aces ── */}
          {cfg.aceBounty != null && (
            <section className="card">
              <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.5rem' }}>
                Hole-in-ones
              </h2>
              {aces.length === 0 ? (
                <p style={{ color: 'var(--slate-mid)', fontSize: '0.85rem', margin: 0 }}>
                  No aces by any team&rsquo;s golfers yet.
                </p>
              ) : (
                <table className="lb-table" style={{ fontSize: '0.85rem' }}>
                  <thead>
                    <tr><th>Golfer</th><th>Tournament</th><th>Round · Hole</th><th>Owned by</th></tr>
                  </thead>
                  <tbody>
                    {aces.map(a => (
                      <tr key={`${a.tournamentId}:${a.golferId}:${a.round}:${a.hole}`}>
                        <td>
                          <strong>{a.golferName}</strong>
                          {a.source === 'manual' && <span className="badge badge-gray" style={{ marginLeft: 6 }}>added by admin</span>}
                        </td>
                        <td>{a.tournamentName}</td>
                        <td>R{a.round} · #{a.hole}</td>
                        <td>
                          {a.owners.length === 0 ? '—' : a.owners.map(o => nameOf.get(o) ?? 'Player').join(', ')}
                          {!a.settled && <span style={{ color: 'var(--slate-mid)' }}> · pays when final</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
