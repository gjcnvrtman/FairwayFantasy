import { redirect, notFound } from 'next/navigation';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import {
  getLeagueBySlug,
  getLeagueMembers,
  getCompletedTournamentsInRange,
  getEffectiveBetsForTournaments,
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
export const metadata: Metadata = { title: 'History' };

export default async function HistoryPage({ params }: Props) {
  const user = await getCurrentUser();
  if (!user) redirect(`/auth/signin?redirect=/league/${params.slug}/history`);

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

  // Completed tournaments inside the league's window (start/end dates).
  // Legacy leagues with NULL dates fall back to unbounded.
  const lgStart = isoOrNull(league.start_date);
  const lgEnd   = isoOrNull(league.end_date);
  const completedTournaments = await getCompletedTournamentsInRange(lgStart, lgEnd);

  const members        = await getLeagueMembers(league.id);
  const membersById    = Object.fromEntries(members.map((m: any) => [m.user_id, m]));
  const betAmount      = Number(league.weekly_bet_amount ?? 0);
  const moneyMembers   = members.map((m: any) => ({
    user_id:   m.user_id,
    joined_at: m.joined_at,
  }));

  // For each tournament, get fantasy_results AND picks (with golfer
  // rows embedded). Picks let the dropdown show actual golfer names
  // per player, not just the four anonymous scores.
  const tournamentResults = await Promise.all(
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
      const picksByUser = new Map<string, any>();
      for (const p of picks) picksByUser.set(p.user_id, p);
      return { tournament: t, results, picksByUser };
    }),
  );

  const withResults = tournamentResults.filter(t => t.results.length > 0);

  // Per-tournament money deltas + cumulative totals, in the same
  // order as `withResults`. computeLeagueMoney excludes members who
  // joined after each tournament's pick-deadline and treats no-pick
  // members as losers (for tournaments they WERE eligible for).
  // Per-tournament bet overrides (migration 010) resolved against the
  // league default for any tournament without an explicit override.
  const effectiveBets = await getEffectiveBetsForTournaments(
    league.id, withResults.map(t => t.tournament.id), betAmount,
  );
  const moneySummary = computeLeagueMoney({
    members: moneyMembers,
    tournaments: withResults.map(({ tournament: t, results }) => ({
      lockedAt:  effectivePickDeadline(t) ?? t.start_date,
      betAmount: effectiveBets.get(t.id) ?? betAmount,
      results:   results.map((r: any) => ({ user_id: r.user_id, rank: r.rank })),
    })),
  });
  const deltaByTourn = moneySummary.byTournament.map(deltas => {
    const m = new Map<string, number>();
    for (const d of deltas) m.set(d.user_id, d.amount);
    return m;
  });
  const moneyTotalsRanked = [...moneySummary.totals].sort((a, b) => b.amount - a.amount);

  // ── Season total-score per player ───────────────────────────
  // Sum total_score across this league's completed tournaments.
  // In golf, lower is better, so we sort ascending (best at top).
  // Only count rows where total_score is non-null (skips players
  // who didn't submit picks for a given tournament).
  const totalScoreByUser = new Map<string, { sum: number; events: number }>();
  for (const { results } of withResults) {
    for (const r of results) {
      if (r.total_score === null || r.total_score === undefined) continue;
      const cur = totalScoreByUser.get(r.user_id) ?? { sum: 0, events: 0 };
      cur.sum    += Number(r.total_score);
      cur.events += 1;
      totalScoreByUser.set(r.user_id, cur);
    }
  }
  const scoreTotalsRanked = Array.from(totalScoreByUser.entries())
    .map(([user_id, v]) => ({ user_id, sum: v.sum, events: v.events }))
    .sort((a, b) => a.sum - b.sum);

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
              {/* ── Season totals: Money + Total Score side-by-side ─── */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                gap: '1.25rem',
              }}>
                {/* Money totals */}
                <div className="card">
                  <h3 style={{
                    fontFamily: "'Playfair Display', serif",
                    fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.2rem',
                  }}>
                    Money — Season Totals
                  </h3>
                  <p style={{ color: 'var(--slate-mid)', fontSize: '0.82rem', marginBottom: '1rem' }}>
                    Net dollars across {withResults.length} completed event{withResults.length === 1 ? '' : 's'} at ${betAmount.toFixed(2)} per event.
                  </p>
                  <div>
                    {moneyTotalsRanked.map((t, i) => {
                      const m  = membersById[t.user_id];
                      const nm = m?.profile?.display_name ?? 'Player';
                      const isMe = t.user_id === user.id;
                      const cls = t.amount > 0 ? 'score-under'
                                : t.amount < 0 ? 'score-over'
                                : 'score-even';
                      return (
                        <div key={t.user_id} style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '0.5rem 0',
                          borderBottom: i < moneyTotalsRanked.length - 1 ? '1px solid var(--cream-dark)' : 'none',
                          fontSize: '0.95rem',
                        }}>
                          <span style={{
                            fontWeight: isMe ? 700 : 500,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            flex: '1 1 auto', minWidth: 0,
                          }}>
                            {nm}
                            {isMe && <span style={{ color: 'var(--brass)', marginLeft: '0.4rem', fontSize: '0.72rem' }}>← you</span>}
                          </span>
                          <strong className={cls} style={{ fontSize: '1.05rem', flexShrink: 0 }}>
                            {formatMoney(t.amount)}
                          </strong>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Total score totals (lower = better in golf) */}
                <div className="card">
                  <h3 style={{
                    fontFamily: "'Playfair Display', serif",
                    fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.2rem',
                  }}>
                    Total Score — Season Totals
                  </h3>
                  <p style={{ color: 'var(--slate-mid)', fontSize: '0.82rem', marginBottom: '1rem' }}>
                    Cumulative score across this league&rsquo;s events. Lower is better.
                  </p>
                  <div>
                    {scoreTotalsRanked.length === 0 ? (
                      <p style={{ color: 'var(--slate-mid)', fontSize: '0.85rem' }}>No scored events yet.</p>
                    ) : scoreTotalsRanked.map((t, i) => {
                      const m  = membersById[t.user_id];
                      const nm = m?.profile?.display_name ?? 'Player';
                      const isMe = t.user_id === user.id;
                      const cls = t.sum < 0 ? 'score-under'
                                : t.sum > 0 ? 'score-over'
                                : 'score-even';
                      return (
                        <div key={t.user_id} style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '0.5rem 0',
                          borderBottom: i < scoreTotalsRanked.length - 1 ? '1px solid var(--cream-dark)' : 'none',
                          fontSize: '0.95rem',
                        }}>
                          <span style={{
                            fontWeight: isMe ? 700 : 500,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            flex: '1 1 auto', minWidth: 0,
                          }}>
                            {nm}
                            {isMe && <span style={{ color: 'var(--brass)', marginLeft: '0.4rem', fontSize: '0.72rem' }}>← you</span>}
                          </span>
                          <span style={{ flexShrink: 0, display: 'flex', alignItems: 'baseline', gap: '0.6rem' }}>
                            <small style={{ color: 'var(--slate-mid)', fontSize: '0.72rem' }}>
                              {t.events} ev
                            </small>
                            <strong className={cls} style={{ fontSize: '1.05rem' }}>
                              {formatScore(t.sum)}
                            </strong>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {withResults.map(({ tournament: t, results, picksByUser }, tIdx) => {
                const winner = results[0];
                const isLatest = tIdx === 0; // most-recent first by query order
                return (
                  <details key={t.id} className="card" style={{ padding: 0, overflow: 'hidden' }} open={isLatest}>
                    {/* Summary (collapsed header — always visible) */}
                    <summary style={{
                      background: t.type === 'major'
                        ? 'linear-gradient(135deg, #1a2f1e 0%, #2d5a34 100%)'
                        : 'var(--green-deep)',
                      color: 'white', padding: '1.25rem 1.5rem',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap',
                      gap: '0.75rem', cursor: 'pointer', listStyle: 'none',
                    }}>
                      <div>
                        {t.type === 'major' && (
                          <div className="major-badge" style={{ marginBottom: '0.4rem' }}>🏆 Major</div>
                        )}
                        <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.2rem', fontWeight: 700 }}>
                          {t.name}
                          <span style={{
                            fontSize: '0.7rem', marginLeft: '0.6rem', color: 'rgba(255,255,255,0.5)',
                            fontWeight: 500, fontFamily: 'inherit',
                          }}>
                            click to {isLatest ? 'collapse' : 'expand'}
                          </span>
                        </h3>
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
                    </summary>

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
                          <th style={{ textAlign: 'right' }}>$ Net</th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.map((r: any, i: number) => {
                          const delta = deltaByTourn[tIdx]?.get(r.user_id) ?? 0;
                          const moneyCls = delta > 0 ? 'score-under'
                                         : delta < 0 ? 'score-over'
                                         : 'score-even';
                          return (
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
                                    r.counting_golfers?.includes(si + 1) && s !== null
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
                            <td style={{ textAlign: 'right' }}>
                              <strong className={moneyCls}>{formatMoney(delta)}</strong>
                            </td>
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>

                    {/* Picks section — golfer names per player, tier-labeled */}
                    {picksByUser.size > 0 && (
                      <div style={{ padding: '1rem 1.5rem 1.25rem' }}>
                        <div style={{
                          fontSize: '0.72rem', color: 'var(--slate-mid)',
                          textTransform: 'uppercase', letterSpacing: '0.12em',
                          fontWeight: 700, marginBottom: '0.75rem',
                        }}>
                          Picks
                        </div>
                        <table className="lb-table" style={{ fontSize: '0.85rem' }}>
                          <thead>
                            <tr>
                              <th>Player</th>
                              <th>Top Tier 1</th>
                              <th>Top Tier 2</th>
                              <th>Dark Horse 1</th>
                              <th>Dark Horse 2</th>
                            </tr>
                          </thead>
                          <tbody>
                            {results.map((r: any) => {
                              const p = picksByUser.get(r.user_id);
                              const isMe = r.user_id === user.id;
                              const slotName = (g: any) => g?.name ?? '—';
                              return (
                                <tr key={r.user_id}>
                                  <td>
                                    <strong>{r.profile?.display_name}</strong>
                                    {isMe && <span style={{ marginLeft: '0.4rem', fontSize: '0.72rem', color: 'var(--brass)' }}>← you</span>}
                                  </td>
                                  <td>{slotName(p?.golfer_1)}</td>
                                  <td>{slotName(p?.golfer_2)}</td>
                                  <td>{slotName(p?.golfer_3)}</td>
                                  <td>{slotName(p?.golfer_4)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </details>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
