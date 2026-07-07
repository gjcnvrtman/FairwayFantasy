import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import {
  getLeagueBySlug,
  getAllTournamentsInRange,
  isoOrNull,
} from '@/lib/db/queries';
import { effectivePickDeadline } from '@/lib/pick-deadline';
import Nav from '@/components/layout/Nav';
import type { Metadata } from 'next';

interface Props { params: { slug: string } }
export const metadata: Metadata = { title: 'Schedule' };

// Tournament status to display label + colour. The DB has four
// statuses; we collapse `active` and `cut_made` into "Live" for
// readability since both mean "underway right now."
function statusBadge(s: string) {
  switch (s) {
    case 'upcoming': return { label: 'Upcoming', bg: '#3a5d72', fg: 'white' };
    case 'active':   return { label: 'Live',     bg: '#c46a2a', fg: 'white' };
    case 'cut_made': return { label: 'Live',     bg: '#c46a2a', fg: 'white' };
    case 'complete': return { label: 'Final',    bg: 'var(--slate-mid)', fg: 'white' };
    default:         return { label: s,          bg: 'var(--cream-dark)', fg: 'var(--slate-deep)' };
  }
}

export default async function SchedulePage({ params }: Props) {
  const user = await getCurrentUser();
  if (!user) redirect(`/auth/signin?redirect=/league/${params.slug}/schedule`);

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
  const all = await getAllTournamentsInRange(league.id, lgStart, lgEnd);

  const now = new Date();
  const upcomingCount  = all.filter(t => t.status === 'upcoming').length;
  const liveCount      = all.filter(t => t.status === 'active' || t.status === 'cut_made').length;
  const completedCount = all.filter(t => t.status === 'complete').length;

  return (
    <div className="page-shell">
      <Nav leagueSlug={params.slug} leagueName={league.name} userName={profile?.display_name} />

      <div className="t-hero" style={{ padding: '2.5rem 1.5rem' }}>
        <div className="container">
          <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '0.4rem' }}>
            {league.name}
          </p>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 'clamp(1.8rem,4vw,2.5rem)', fontWeight: 900 }}>
            Schedule
          </h1>
          <p style={{ color: 'rgba(255,255,255,0.5)', marginTop: '0.3rem', fontSize: '0.875rem' }}>
            {all.length} tournament{all.length === 1 ? '' : 's'} · {upcomingCount} upcoming · {liveCount} live · {completedCount} complete
          </p>
        </div>
      </div>

      <div className="page-content">
        <div className="container">
          {all.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', padding: '4rem 2rem' }}>
              <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📅</div>
              <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.3rem', marginBottom: '0.5rem' }}>No tournaments scheduled</h3>
              <p style={{ color: 'var(--slate-mid)' }}>The league&rsquo;s date window has no tournaments yet.</p>
            </div>
          ) : (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <table className="lb-table">
                <thead>
                  <tr>
                    <th>Tournament</th>
                    <th className="hide-mobile">Course</th>
                    <th>Dates</th>
                    <th className="hide-mobile">Pick Deadline</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Link</th>
                  </tr>
                </thead>
                <tbody>
                  {all.map(t => {
                    const badge = statusBadge(t.status);
                    const start = new Date(t.start_date);
                    const end   = new Date(t.end_date);
                    const sameMonth = start.getMonth() === end.getMonth();
                    const dateStr = sameMonth
                      ? `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}–${end.toLocaleDateString('en-US', { day: 'numeric', year: 'numeric' })}`
                      : `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

                    const dl = effectivePickDeadline(t);
                    const dlStr = dl
                      ? dl.toLocaleString('en-US', {
                          month: 'short', day: 'numeric',
                          hour: 'numeric', minute: '2-digit',
                        })
                      : '—';

                    // Link target: completed → history; otherwise picks.
                    // For upcoming events, picks are gated until ESPN
                    // publishes the field (Migration 007 / runFieldSync).
                    // When field_published_at IS NULL we render disabled
                    // "Field pending" text instead of a click target — the
                    // picks page itself would just show the same banner.
                    const isComplete    = t.status === 'complete';
                    const isUpcoming    = t.status === 'upcoming';
                    const fieldPending  = isUpcoming && !t.field_published_at;

                    const linkHref = isComplete
                      ? `/league/${params.slug}/history`
                      : `/league/${params.slug}/picks`;
                    const linkLabel = isComplete ? 'Results →' : 'Picks →';

                    const isPast = end < now;

                    return (
                      <tr key={t.id} style={{ opacity: isPast && !isComplete ? 0.7 : 1 }}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                            <strong>{t.name}</strong>
                            {t.type === 'major' && (
                              <span className="major-badge" style={{ fontSize: '0.65rem' }}>🏆 Major</span>
                            )}
                          </div>
                        </td>
                        <td className="hide-mobile" style={{ color: 'var(--slate-mid)', fontSize: '0.85rem' }}>
                          {t.course_name ?? '—'}
                        </td>
                        <td style={{ fontSize: '0.88rem' }}>{dateStr}</td>
                        <td className="hide-mobile" style={{ fontSize: '0.85rem', color: 'var(--slate-mid)' }}>{dlStr}</td>
                        <td>
                          <span style={{
                            display: 'inline-block',
                            padding: '0.18rem 0.55rem',
                            background: badge.bg,
                            color: badge.fg,
                            borderRadius: '4px',
                            fontSize: '0.7rem',
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            letterSpacing: '0.08em',
                          }}>
                            {badge.label}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {fieldPending ? (
                            <span
                              title="ESPN hasn't published the field yet. Picks unlock automatically when it's available."
                              style={{
                                color: 'var(--slate-light)',
                                fontSize: '0.85rem',
                                fontWeight: 600,
                                fontStyle: 'italic',
                                cursor: 'not-allowed',
                              }}
                            >
                              Field pending
                            </span>
                          ) : (
                            <Link href={linkHref} style={{ color: 'var(--brass)', fontSize: '0.85rem', fontWeight: 600 }}>
                              {linkLabel}
                            </Link>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
