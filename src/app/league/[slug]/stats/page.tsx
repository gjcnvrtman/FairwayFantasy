import { redirect, notFound } from 'next/navigation';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import {
  getLeagueBySlug,
  getLeagueMembers,
  getCompletedTournamentsInRange,
  getPicksForTournament,
  isoOrNull,
} from '@/lib/db/queries';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { formatScore } from '@/lib/scoring';
import { computeLeagueMoney, formatMoney } from '@/lib/money';
import { effectivePickDeadline } from '@/lib/pick-deadline';
import Nav from '@/components/layout/Nav';
import type { Metadata } from 'next';

interface Props { params: { slug: string } }
export const metadata: Metadata = { title: 'Stats' };

export default async function StatsPage({ params }: Props) {
  const user = await getCurrentUser();
  if (!user) redirect(`/auth/signin?redirect=/league/${params.slug}/stats`);

  const league = await getLeagueBySlug(params.slug);
  if (!league) notFound();

  const membership = await db.selectFrom('league_members')
    .select('role')
    .where('league_id', '=', league.id)
    .where('user_id',   '=', user.id)
    .executeTakeFirst();
  if (!membership) redirect(`/join/${params.slug}/${league.invite_code}`);

  const profile = await db.selectFrom('profiles')
    .select('display_name')
    .where('id', '=', user.id)
    .executeTakeFirst();

  const lgStart = isoOrNull(league.start_date);
  const lgEnd   = isoOrNull(league.end_date);
  const completedTournaments = await getCompletedTournamentsInRange(lgStart, lgEnd);

  const members      = await getLeagueMembers(league.id);
  const membersById  = Object.fromEntries(members.map((m: any) => [m.user_id, m]));
  const betAmount    = Number(league.weekly_bet_amount ?? 0);
  const moneyMembers = members.map((m: any) => ({ user_id: m.user_id, joined_at: m.joined_at }));

  // Pull results + picks for every completed tournament. Picks feed
  // the "most picked" stats; results feed everything else.
  const perTournament = await Promise.all(
    completedTournaments.map(async t => {
      const results = await db.selectFrom('fantasy_results')
        .selectAll('fantasy_results')
        .select(eb => jsonObjectFrom(
          eb.selectFrom('profiles')
            .select('display_name')
            .whereRef('profiles.id', '=', 'fantasy_results.user_id'),
        ).as('profile'))
        .where('league_id',     '=', league.id)
        .where('tournament_id', '=', t.id)
        .orderBy('rank', 'asc')
        .execute();
      const picks = await getPicksForTournament(league.id, t.id);
      return { tournament: t, results, picks };
    }),
  );
  const withResults = perTournament.filter(t => t.results.length > 0);

  // ── Money totals (reuse the same helper as History) ─────────
  const moneySummary = computeLeagueMoney({
    members: moneyMembers,
    tournaments: withResults.map(({ tournament: t, results }) => ({
      lockedAt:  effectivePickDeadline(t) ?? t.start_date,
      betAmount,
      results:   results.map((r: any) => ({ user_id: r.user_id, rank: r.rank })),
    })),
  });
  const moneyByUser = new Map(moneySummary.totals.map(t => [t.user_id, t.amount]));

  // ── Per-player aggregates ────────────────────────────────────
  // Track wins (rank=1 incl. ties), 2nd, 3rd, total/best/worst/avg
  // score, and tournaments played. A "tournament played" = had a
  // fantasy_results row with non-null total_score (so a member who
  // joined late but didn't submit picks for a given event isn't
  // counted as having played it).
  interface PlayerAgg {
    user_id:     string;
    name:        string;
    wins:        number;
    seconds:     number;
    thirds:      number;
    played:      number;
    totalScore:  number;
    bestScore:   number | null;  // min over events
    worstScore:  number | null;  // max over events
    bestEvent:   string | null;
    worstEvent:  string | null;
  }
  const playerStats = new Map<string, PlayerAgg>();
  for (const m of members) {
    playerStats.set(m.user_id, {
      user_id:    m.user_id,
      name:       m.profile?.display_name ?? 'Player',
      wins: 0, seconds: 0, thirds: 0, played: 0,
      totalScore: 0,
      bestScore:  null, worstScore:  null,
      bestEvent:  null, worstEvent:  null,
    });
  }

  // Track the league-wide single-tournament records as we walk
  let leagueLowestScore:  { score: number; user: string; tournament: string } | null = null;
  let leagueHighestScore: { score: number; user: string; tournament: string } | null = null;

  for (const { tournament: t, results } of withResults) {
    for (const r of results) {
      const a = playerStats.get(r.user_id);
      if (!a) continue;
      if (r.rank === 1) a.wins    += 1;
      if (r.rank === 2) a.seconds += 1;
      if (r.rank === 3) a.thirds  += 1;
      if (r.total_score === null || r.total_score === undefined) continue;
      const s = Number(r.total_score);
      a.played     += 1;
      a.totalScore += s;
      if (a.bestScore === null || s < a.bestScore) {
        a.bestScore = s;  a.bestEvent  = t.name;
      }
      if (a.worstScore === null || s > a.worstScore) {
        a.worstScore = s; a.worstEvent = t.name;
      }
      const playerName = r.profile?.display_name ?? a.name;
      if (leagueLowestScore === null || s < leagueLowestScore.score) {
        leagueLowestScore = { score: s, user: playerName, tournament: t.name };
      }
      if (leagueHighestScore === null || s > leagueHighestScore.score) {
        leagueHighestScore = { score: s, user: playerName, tournament: t.name };
      }
    }
  }

  // Played-only list (skip members who never submitted picks);
  // sort by wins desc, then total payout desc as tiebreaker
  const playerRows = Array.from(playerStats.values())
    .filter(p => p.played > 0)
    .sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      const pa = moneyByUser.get(a.user_id) ?? 0;
      const pb = moneyByUser.get(b.user_id) ?? 0;
      return pb - pa;
    });

  // ── League-wide stats: most-picked golfers (split top tier vs DH) ──
  // A "top tier pick" = slot 1 or 2 (golfer_1_id, golfer_2_id).
  // A "dark horse pick" = slot 3 or 4 (golfer_3_id, golfer_4_id).
  // This matches the pick page's slot convention; we deliberately
  // count by slot rather than by golfers.is_dark_horse so a golfer
  // who climbed/dropped the rankings mid-season still gets counted
  // against the slot they were picked into.
  const topTierCount  = new Map<string, { name: string; count: number }>();
  const darkHorseCount = new Map<string, { name: string; count: number }>();
  // Per-user pick aggregation (mirrors topTierCount + darkHorseCount
  // structure but keyed first by user_id). Drives the per-player
  // breakdown section below — answers "what does THIS player
  // gravitate to?" rather than "what does the league gravitate to?"
  type PickCount = Map<string, { name: string; count: number }>;
  const topTierByUser:  Map<string, PickCount> = new Map();
  const darkHorseByUser: Map<string, PickCount> = new Map();
  let leagueScoreSum = 0;
  let leagueScoreEvents = 0;
  for (const { results, picks } of withResults) {
    for (const p of picks as any[]) {
      const add = (m: PickCount, g: any) => {
        if (!g) return;
        const cur = m.get(g.id) ?? { name: g.name, count: 0 };
        cur.count += 1;
        m.set(g.id, cur);
      };
      // League-wide
      add(topTierCount,  p.golfer_1);
      add(topTierCount,  p.golfer_2);
      add(darkHorseCount, p.golfer_3);
      add(darkHorseCount, p.golfer_4);
      // Per-user — lazy-init the inner map on first sighting
      if (!topTierByUser.has(p.user_id))   topTierByUser.set(p.user_id, new Map());
      if (!darkHorseByUser.has(p.user_id)) darkHorseByUser.set(p.user_id, new Map());
      add(topTierByUser.get(p.user_id)!,   p.golfer_1);
      add(topTierByUser.get(p.user_id)!,   p.golfer_2);
      add(darkHorseByUser.get(p.user_id)!, p.golfer_3);
      add(darkHorseByUser.get(p.user_id)!, p.golfer_4);
    }
    for (const r of results) {
      if (r.total_score === null || r.total_score === undefined) continue;
      leagueScoreSum    += Number(r.total_score);
      leagueScoreEvents += 1;
    }
  }
  const top5 = (m: PickCount) =>
    Array.from(m.values()).sort((a, b) => b.count - a.count).slice(0, 5);
  const topTierTop5  = top5(topTierCount);
  const darkHorseTop5 = top5(darkHorseCount);
  const leagueAvg = leagueScoreEvents ? leagueScoreSum / leagueScoreEvents : null;

  return (
    <div className="page-shell">
      <Nav leagueSlug={params.slug} leagueName={league.name} userName={profile?.display_name} />

      <div className="t-hero" style={{ padding: '2.5rem 1.5rem' }}>
        <div className="container">
          <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '0.4rem' }}>
            {league.name}
          </p>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 'clamp(1.8rem,4vw,2.5rem)', fontWeight: 900 }}>
            League Stats
          </h1>
          <p style={{ color: 'rgba(255,255,255,0.5)', marginTop: '0.3rem', fontSize: '0.875rem' }}>
            Across {withResults.length} completed event{withResults.length === 1 ? '' : 's'}
          </p>
        </div>
      </div>

      <div className="page-content">
        <div className="container">
          {withResults.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', padding: '4rem 2rem' }}>
              <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📊</div>
              <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.3rem', marginBottom: '0.5rem' }}>No stats yet</h3>
              <p style={{ color: 'var(--slate-mid)' }}>Stats will appear once tournaments complete.</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
              {/* ── Per-player record table ─────────────────────── */}
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{
                  background: 'var(--green-deep)', color: 'white',
                  padding: '1rem 1.5rem',
                }}>
                  <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.2rem', fontWeight: 700 }}>
                    Player Records
                  </h3>
                </div>
                <table className="lb-table">
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th style={{ textAlign: 'center' }}>🥇 W</th>
                      <th style={{ textAlign: 'center' }} className="hide-mobile">🥈 2nd</th>
                      <th style={{ textAlign: 'center' }} className="hide-mobile">🥉 3rd</th>
                      <th style={{ textAlign: 'center' }} className="hide-mobile">Events</th>
                      <th style={{ textAlign: 'right' }}>Payout</th>
                      <th style={{ textAlign: 'right' }} className="hide-mobile">Best</th>
                      <th style={{ textAlign: 'right' }} className="hide-mobile">Worst</th>
                      <th style={{ textAlign: 'right' }}>Avg</th>
                    </tr>
                  </thead>
                  <tbody>
                    {playerRows.map(p => {
                      const isMe = p.user_id === user.id;
                      const payout = moneyByUser.get(p.user_id) ?? 0;
                      const payCls = payout > 0 ? 'score-under' : payout < 0 ? 'score-over' : 'score-even';
                      const avg = p.played > 0 ? p.totalScore / p.played : 0;
                      const avgCls = avg < 0 ? 'score-under' : avg > 0 ? 'score-over' : 'score-even';
                      return (
                        <tr key={p.user_id}>
                          <td>
                            <strong>{p.name}</strong>
                            {isMe && <span style={{ marginLeft: '0.4rem', fontSize: '0.72rem', color: 'var(--brass)' }}>← you</span>}
                          </td>
                          <td style={{ textAlign: 'center', fontWeight: 700 }}>{p.wins}</td>
                          <td style={{ textAlign: 'center' }} className="hide-mobile">{p.seconds}</td>
                          <td style={{ textAlign: 'center' }} className="hide-mobile">{p.thirds}</td>
                          <td style={{ textAlign: 'center' }} className="hide-mobile">{p.played}</td>
                          <td style={{ textAlign: 'right' }}>
                            <strong className={payCls}>{formatMoney(payout)}</strong>
                          </td>
                          <td style={{ textAlign: 'right' }} className="hide-mobile">
                            <span title={p.bestEvent ?? ''} className={p.bestScore !== null && p.bestScore < 0 ? 'score-under' : ''}>
                              {p.bestScore !== null ? formatScore(p.bestScore) : '—'}
                            </span>
                          </td>
                          <td style={{ textAlign: 'right' }} className="hide-mobile">
                            <span title={p.worstEvent ?? ''} className={p.worstScore !== null && p.worstScore > 0 ? 'score-over' : ''}>
                              {p.worstScore !== null ? formatScore(p.worstScore) : '—'}
                            </span>
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <strong className={avgCls}>{p.played > 0 ? formatScore(Math.round(avg * 10) / 10) : '—'}</strong>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* ── League records + averages row ───────────────── */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                gap: '1.25rem',
              }}>
                <div className="card">
                  <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.05rem', fontWeight: 700, marginBottom: '0.75rem' }}>
                    League Records
                  </h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem', fontSize: '0.9rem' }}>
                    {leagueLowestScore && (
                      <div style={{ borderLeft: '3px solid #2d5a34', paddingLeft: '0.7rem' }}>
                        <div style={{ fontSize: '0.7rem', color: 'var(--slate-mid)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700 }}>
                          Best Tournament
                        </div>
                        <div>
                          <strong className="score-under">{formatScore(leagueLowestScore.score)}</strong>
                          {' · '}{leagueLowestScore.user}
                        </div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--slate-mid)' }}>{leagueLowestScore.tournament}</div>
                      </div>
                    )}
                    {leagueHighestScore && (
                      <div style={{ borderLeft: '3px solid #a44a3a', paddingLeft: '0.7rem' }}>
                        <div style={{ fontSize: '0.7rem', color: 'var(--slate-mid)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700 }}>
                          Worst Tournament
                        </div>
                        <div>
                          <strong className="score-over">{formatScore(leagueHighestScore.score)}</strong>
                          {' · '}{leagueHighestScore.user}
                        </div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--slate-mid)' }}>{leagueHighestScore.tournament}</div>
                      </div>
                    )}
                    {leagueAvg !== null && (
                      <div style={{ borderLeft: '3px solid var(--brass)', paddingLeft: '0.7rem' }}>
                        <div style={{ fontSize: '0.7rem', color: 'var(--slate-mid)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700 }}>
                          League Average
                        </div>
                        <div>
                          <strong className={leagueAvg < 0 ? 'score-under' : leagueAvg > 0 ? 'score-over' : 'score-even'}>
                            {formatScore(Math.round(leagueAvg * 10) / 10)}
                          </strong>
                        </div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--slate-mid)' }}>
                          Across {leagueScoreEvents} player-event{leagueScoreEvents === 1 ? '' : 's'}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Most picked top tier */}
                <div className="card">
                  <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.05rem', fontWeight: 700, marginBottom: '0.2rem' }}>
                    Most Picked — Top Tier
                  </h3>
                  <p style={{ color: 'var(--slate-mid)', fontSize: '0.78rem', marginBottom: '0.75rem' }}>
                    Across both top-tier slots, every player, every event.
                  </p>
                  {topTierTop5.length === 0 ? (
                    <p style={{ color: 'var(--slate-mid)', fontSize: '0.85rem' }}>No picks yet.</p>
                  ) : (
                    <div>
                      {topTierTop5.map((g, i) => (
                        <div key={g.name + i} style={{
                          display: 'flex', justifyContent: 'space-between',
                          padding: '0.4rem 0',
                          borderBottom: i < topTierTop5.length - 1 ? '1px solid var(--cream-dark)' : 'none',
                          fontSize: '0.9rem',
                        }}>
                          <span>
                            <span style={{ color: 'var(--slate-mid)', marginRight: '0.5rem', fontSize: '0.78rem' }}>#{i + 1}</span>
                            <strong>{g.name}</strong>
                          </span>
                          <strong style={{ color: 'var(--brass)' }}>{g.count}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Most picked dark horse */}
                <div className="card">
                  <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.05rem', fontWeight: 700, marginBottom: '0.2rem' }}>
                    Most Picked — Dark Horse
                  </h3>
                  <p style={{ color: 'var(--slate-mid)', fontSize: '0.78rem', marginBottom: '0.75rem' }}>
                    Across both dark-horse slots, every player, every event.
                  </p>
                  {darkHorseTop5.length === 0 ? (
                    <p style={{ color: 'var(--slate-mid)', fontSize: '0.85rem' }}>No picks yet.</p>
                  ) : (
                    <div>
                      {darkHorseTop5.map((g, i) => (
                        <div key={g.name + i} style={{
                          display: 'flex', justifyContent: 'space-between',
                          padding: '0.4rem 0',
                          borderBottom: i < darkHorseTop5.length - 1 ? '1px solid var(--cream-dark)' : 'none',
                          fontSize: '0.9rem',
                        }}>
                          <span>
                            <span style={{ color: 'var(--slate-mid)', marginRight: '0.5rem', fontSize: '0.78rem' }}>#{i + 1}</span>
                            <strong>{g.name}</strong>
                          </span>
                          <strong style={{ color: 'var(--brass)' }}>{g.count}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* ── Per-player profiles ─────────────────────────────
                   Mirrors the league-wide cards above, but broken
                   out per player. Each player gets a collapsible
                   <details> card with their headline stats always
                   visible in the summary header, and best/worst
                   tournament + their personal top-5 picks revealed
                   on expand. Same picks-by-slot convention as the
                   league-wide aggregates. */}
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ background: 'var(--green-deep)', color: 'white', padding: '1rem 1.5rem' }}>
                  <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.2rem', fontWeight: 700 }}>
                    Player Profiles
                  </h3>
                  <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.8rem', marginTop: '0.2rem' }}>
                    Click a player to expand their best / worst event and most-picked golfers.
                  </p>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {playerRows.map((p, idx) => {
                    const isMe   = p.user_id === user.id;
                    const payout = moneyByUser.get(p.user_id) ?? 0;
                    const payCls = payout > 0 ? 'score-under' : payout < 0 ? 'score-over' : 'score-even';
                    const avg    = p.played > 0 ? p.totalScore / p.played : 0;
                    const avgCls = avg < 0 ? 'score-under' : avg > 0 ? 'score-over' : 'score-even';
                    const userTopTier   = top5(topTierByUser.get(p.user_id)   ?? new Map());
                    const userDarkHorse = top5(darkHorseByUser.get(p.user_id) ?? new Map());

                    return (
                      <details
                        key={p.user_id}
                        style={{
                          borderTop: idx === 0 ? 'none' : '1px solid var(--cream-dark)',
                        }}
                      >
                        <summary style={{
                          cursor: 'pointer', listStyle: 'none',
                          padding: '0.85rem 1.5rem',
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          gap: '1rem', flexWrap: 'wrap',
                        }}>
                          <span style={{
                            fontWeight: 700, fontSize: '0.95rem',
                            display: 'flex', alignItems: 'center', gap: '0.5rem',
                            minWidth: 0,
                          }}>
                            <span style={{ color: 'var(--slate-mid)', fontSize: '0.78rem' }}>#{idx + 1}</span>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {p.name}
                            </span>
                            {isMe && <span style={{ color: 'var(--brass)', fontSize: '0.72rem', fontWeight: 500 }}>← you</span>}
                          </span>
                          <span style={{
                            display: 'flex', gap: '1.25rem', alignItems: 'baseline',
                            fontSize: '0.82rem', color: 'var(--slate-mid)', flexWrap: 'wrap',
                          }}>
                            <span>🥇 <strong style={{ color: 'var(--ink)' }}>{p.wins}</strong></span>
                            <span className="hide-mobile">🥈 <strong style={{ color: 'var(--ink)' }}>{p.seconds}</strong></span>
                            <span className="hide-mobile">🥉 <strong style={{ color: 'var(--ink)' }}>{p.thirds}</strong></span>
                            <span>events <strong style={{ color: 'var(--ink)' }}>{p.played}</strong></span>
                            <span>payout <strong className={payCls}>{formatMoney(payout)}</strong></span>
                            <span>avg <strong className={avgCls}>
                              {p.played > 0 ? formatScore(Math.round(avg * 10) / 10) : '—'}
                            </strong></span>
                          </span>
                        </summary>

                        <div style={{
                          padding: '0 1.5rem 1.25rem',
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                          gap: '1.25rem',
                        }}>
                          {/* Best / Worst tournament for this player */}
                          <div>
                            <div style={{
                              fontSize: '0.72rem', color: 'var(--slate-mid)',
                              textTransform: 'uppercase', letterSpacing: '0.1em',
                              fontWeight: 700, marginBottom: '0.5rem',
                            }}>
                              Personal Records
                            </div>
                            {p.bestScore !== null ? (
                              <div style={{ marginBottom: '0.6rem', borderLeft: '3px solid #2d5a34', paddingLeft: '0.6rem' }}>
                                <div style={{ fontSize: '0.7rem', color: 'var(--slate-mid)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Best</div>
                                <div style={{ fontSize: '0.9rem' }}>
                                  <strong className={p.bestScore < 0 ? 'score-under' : ''}>{formatScore(p.bestScore)}</strong>
                                  <span style={{ color: 'var(--slate-mid)' }}> · {p.bestEvent ?? '—'}</span>
                                </div>
                              </div>
                            ) : (
                              <p style={{ color: 'var(--slate-mid)', fontSize: '0.85rem' }}>No scored events yet.</p>
                            )}
                            {p.worstScore !== null && (
                              <div style={{ borderLeft: '3px solid #a44a3a', paddingLeft: '0.6rem' }}>
                                <div style={{ fontSize: '0.7rem', color: 'var(--slate-mid)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Worst</div>
                                <div style={{ fontSize: '0.9rem' }}>
                                  <strong className={p.worstScore > 0 ? 'score-over' : ''}>{formatScore(p.worstScore)}</strong>
                                  <span style={{ color: 'var(--slate-mid)' }}> · {p.worstEvent ?? '—'}</span>
                                </div>
                              </div>
                            )}
                          </div>

                          {/* Their most-picked top tier */}
                          <div>
                            <div style={{
                              fontSize: '0.72rem', color: 'var(--slate-mid)',
                              textTransform: 'uppercase', letterSpacing: '0.1em',
                              fontWeight: 700, marginBottom: '0.5rem',
                            }}>
                              Most Picked — Top Tier
                            </div>
                            {userTopTier.length === 0 ? (
                              <p style={{ color: 'var(--slate-mid)', fontSize: '0.85rem' }}>No picks yet.</p>
                            ) : userTopTier.map((g, i) => (
                              <div key={g.name + i} style={{
                                display: 'flex', justifyContent: 'space-between',
                                padding: '0.3rem 0',
                                borderBottom: i < userTopTier.length - 1 ? '1px solid var(--cream-dark)' : 'none',
                                fontSize: '0.88rem',
                              }}>
                                <span>
                                  <span style={{ color: 'var(--slate-mid)', marginRight: '0.4rem', fontSize: '0.74rem' }}>#{i + 1}</span>
                                  {g.name}
                                </span>
                                <strong style={{ color: 'var(--brass)' }}>{g.count}</strong>
                              </div>
                            ))}
                          </div>

                          {/* Their most-picked dark horse */}
                          <div>
                            <div style={{
                              fontSize: '0.72rem', color: 'var(--slate-mid)',
                              textTransform: 'uppercase', letterSpacing: '0.1em',
                              fontWeight: 700, marginBottom: '0.5rem',
                            }}>
                              Most Picked — Dark Horse
                            </div>
                            {userDarkHorse.length === 0 ? (
                              <p style={{ color: 'var(--slate-mid)', fontSize: '0.85rem' }}>No picks yet.</p>
                            ) : userDarkHorse.map((g, i) => (
                              <div key={g.name + i} style={{
                                display: 'flex', justifyContent: 'space-between',
                                padding: '0.3rem 0',
                                borderBottom: i < userDarkHorse.length - 1 ? '1px solid var(--cream-dark)' : 'none',
                                fontSize: '0.88rem',
                              }}>
                                <span>
                                  <span style={{ color: 'var(--slate-mid)', marginRight: '0.4rem', fontSize: '0.74rem' }}>#{i + 1}</span>
                                  {g.name}
                                </span>
                                <strong style={{ color: 'var(--brass)' }}>{g.count}</strong>
                              </div>
                            ))}
                          </div>
                        </div>
                      </details>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
