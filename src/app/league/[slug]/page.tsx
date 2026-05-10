import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/current-user';
import {
  supabaseAdmin,
  getLeagueBySlug,
  getLeagueMembers,
  getActiveTournament,
  getFantasyLeaderboard,
  getSeasonStandings,
  getUpcomingTournaments,
  getPicksForTournament,
} from '@/lib/supabase';
import { formatScore } from '@/lib/scoring';
import {
  deriveLockStatus,
  shouldRevealOtherPicks,
  deriveLeagueEmptyState,
  deriveHeroCTA,
} from '@/lib/league-dashboard';
import Nav from '@/components/layout/Nav';
import InviteCard from '@/components/league/InviteCard';
import type { Metadata } from 'next';

interface Props { params: { slug: string } }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const league = await getLeagueBySlug(params.slug);
  return { title: league ? `${league.name} — Leaderboard` : 'League Not Found' };
}

export default async function LeaguePage({ params }: Props) {
  const user = await getCurrentUser();
  if (!user) redirect(`/auth/signin?redirect=/league/${params.slug}`);

  const league = await getLeagueBySlug(params.slug);
  if (!league) notFound();

  // Verify membership
  const { data: membership } = await supabaseAdmin
    .from('league_members').select('role').eq('league_id', league.id).eq('user_id', user.id).single();
  if (!membership) redirect(`/join/${params.slug}/${league.invite_code}`);

  const { data: profile } = await supabaseAdmin.from('profiles').select('display_name').eq('id', user.id).single();

  const [members, activeTournament, upcoming, standings] = await Promise.all([
    getLeagueMembers(league.id),
    getActiveTournament(),
    getUpcomingTournaments(4),
    getSeasonStandings(league.id, new Date().getFullYear()),
  ]);

  const [leaderboard, allPicks] = activeTournament
    ? await Promise.all([
        getFantasyLeaderboard(league.id, activeTournament.id),
        getPicksForTournament(league.id, activeTournament.id),
      ])
    : [[], []];

  // Build a per-user pick map so the leaderboard rows can render the
  // foursome inline (post-lock) without an extra query per row.
  const picksByUser = new Map<string, any>();
  for (const p of allPicks) picksByUser.set(p.user_id, p);
  const myPick = picksByUser.get(user.id) ?? null;

  // ── Derived UI state (pure helpers in @/lib/league-dashboard) ──
  const lock        = deriveLockStatus(activeTournament);
  const revealPicks = shouldRevealOtherPicks(lock);
  const empty       = deriveLeagueEmptyState({
    memberCount:        members.length,
    hasActiveTournament: !!activeTournament,
    hasUpcoming:        upcoming.length > 0,
  });
  const heroCTA = deriveHeroCTA({
    hasActiveTournament: !!activeTournament,
    hasUpcoming:        upcoming.length > 0,
    userHasPick:        !!myPick,
    lock,
  });
  const isCommissioner = membership.role === 'commissioner';

  const inviteUrl = `${process.env.NEXT_PUBLIC_SITE_URL ?? ''}/join/${league.slug}/${league.invite_code}`;
  const invitePath = `/join/${league.slug}/${league.invite_code}`;
  const nextTournament = upcoming.find((t: any) => t.id !== activeTournament?.id);

  return (
    <div className="page-shell">
      <Nav leagueSlug={params.slug} leagueName={league.name} userName={profile?.display_name} />

      {/* ── Hero ─────────────────────────────────────────────── */}
      <div className="t-hero" style={{ padding: '2.5rem 1.5rem' }}>
        <div className="container">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
            <div style={{ minWidth: 0 }}>
              <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '0.4rem' }}>
                Private League
              </p>
              <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 'clamp(1.8rem,4vw,2.8rem)', fontWeight: 900 }}>
                {league.name}
              </h1>
              <p style={{ color: 'rgba(255,255,255,0.5)', marginTop: '0.3rem', fontSize: '0.875rem' }}>
                {members.length} player{members.length !== 1 ? 's' : ''} · {new Date().getFullYear()} season
                {isCommissioner && <span style={{ marginLeft: '0.75rem', color: 'var(--brass-light)' }}>★ Commissioner</span>}
              </p>
            </div>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <HeroCTAButton cta={heroCTA} slug={params.slug} />
              {isCommissioner && (
                <Link href={`/league/${params.slug}/admin`} className="btn btn-outline-white btn-sm">
                  ⚙️ Admin
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="page-content">
        <div className="container">

          {/* ── Lock status row — directly answers "are picks open?" ── */}
          <LockStatusBanner
            lock={lock}
            tournamentName={activeTournament?.name ?? nextTournament?.name ?? null}
          />

          {/* Layout: flex-wrap so on narrow viewports the sidebar wraps below.
              No media queries — just `flex: 0 1 300px` keeps the sidebar 300px
              wide when there's room and lets it grow to the full width when there
              isn't.  Bug #6 (was: gridTemplateColumns: '1fr 300px'). */}
          <div style={{
            display: 'flex', flexFlow: 'row wrap', gap: '2rem',
            alignItems: 'flex-start', marginTop: '1rem',
          }}>

            {/* ── Main column ─────────────────────────────────── */}
            <div style={{ flex: '1 1 480px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2rem' }}>

              {activeTournament ? (
                <ActiveTournamentSection
                  tournament={activeTournament}
                  myPick={myPick}
                  leaderboard={leaderboard}
                  picksByUser={picksByUser}
                  revealPicks={revealPicks}
                  currentUserId={user.id}
                  slug={params.slug}
                />
              ) : (
                <NoActiveTournamentSection
                  empty={empty}
                  isCommissioner={isCommissioner}
                  nextTournament={nextTournament}
                  slug={params.slug}
                />
              )}

              {/* Solo-commissioner empty state — only when relevant */}
              {empty === 'solo-commissioner' && activeTournament && (
                <SoloCommissionerCard isCommissioner={isCommissioner} />
              )}
            </div>

            {/* ── Sidebar ─────────────────────────────────────── */}
            <aside style={{ flex: '0 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

              {/* Season standings */}
              <div className="card">
                <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1rem', fontWeight: 700, marginBottom: '1rem' }}>
                  {new Date().getFullYear()} Standings
                </h3>
                {standings.length === 0 ? (
                  <p style={{ color: 'var(--slate-mid)', fontSize: '0.875rem' }}>
                    No results yet this season. Standings populate after the first tournament.
                  </p>
                ) : standings.map((s: any, i: number) => (
                  <div key={s.user_id} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '0.6rem 0', borderBottom: i < standings.length - 1 ? '1px solid var(--cream-dark)' : 'none',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', minWidth: 0 }}>
                      <span style={{
                        fontFamily: "'Playfair Display', serif", fontWeight: 700, fontSize: '1rem', width: 18,
                        flexShrink: 0,
                        color: i === 0 ? '#b8860b' : i === 1 ? '#808080' : i === 2 ? '#a0522d' : 'var(--slate-mid)',
                      }}>{i + 1}</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{
                          fontSize: '0.875rem',
                          fontWeight: s.user_id === user.id ? 700 : 500,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {s.profile?.display_name ?? 'Player'}
                          {s.user_id === user.id && <span style={{ color: 'var(--brass)', marginLeft: '0.3rem', fontSize: '0.7rem' }}>you</span>}
                        </div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--slate-mid)' }}>
                          {s.tournaments_played} event{s.tournaments_played !== 1 ? 's' : ''}
                        </div>
                      </div>
                    </div>
                    <strong className={s.total_score < 0 ? 'score-under' : s.total_score > 0 ? 'score-over' : 'score-even'} style={{ fontSize: '0.95rem', flexShrink: 0 }}>
                      {formatScore(s.total_score)}
                    </strong>
                  </div>
                ))}
              </div>

              {/* Roster */}
              <div className="card">
                <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1rem', fontWeight: 700, marginBottom: '1rem' }}>
                  League Roster
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {members.map((m: any) => (
                    <div key={m.user_id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.875rem', gap: '0.5rem' }}>
                      <span style={{
                        fontWeight: m.user_id === user.id ? 700 : 400,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {m.profile?.display_name ?? 'Player'}
                        {m.user_id === user.id && <span style={{ color: 'var(--slate-mid)', marginLeft: '0.3rem', fontSize: '0.75rem' }}>(you)</span>}
                      </span>
                      {m.role === 'commissioner' && <span className="badge badge-brass" style={{ fontSize: '0.62rem', flexShrink: 0 }}>★ Comm</span>}
                    </div>
                  ))}
                </div>
                {members.length < league.max_players && (
                  <p style={{ marginTop: '0.75rem', fontSize: '0.72rem', color: 'var(--slate-light)' }}>
                    Room for {league.max_players - members.length} more.
                  </p>
                )}
              </div>

              {/* Invite — client component, lifted out of the server tree
                  so the copy button's onClick actually works. Bug #4.9. */}
              <InviteCard
                inviteUrl={inviteUrl}
                invitePath={invitePath}
                title={isCommissioner ? 'Invite Players' : 'Invite Friends'}
                subhead={
                  isCommissioner
                    ? 'Share this link — anyone who clicks it can join your league.'
                    : 'Anyone you share with can join the league using this link.'
                }
              />
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Subcomponents (server-renderable — keep them out of the page
// body for readability; nothing here is interactive)
// ─────────────────────────────────────────────────────────────

function HeroCTAButton({ cta, slug }: { cta: ReturnType<typeof deriveHeroCTA>; slug: string }) {
  if (cta === 'none') return null;
  // Narrowed cta is one of the four actionable states.
  const labels = {
    'submit-picks': '📋 Submit Picks',
    'edit-picks':   '✏️ Edit My Picks',
    'view-picks':   '👀 View My Picks',
    'submit-next':  '📋 Pick Next Tournament',
  } as const;
  return (
    <Link href={`/league/${slug}/picks`} className="btn btn-brass">
      {labels[cta]}
    </Link>
  );
}

function LockStatusBanner({
  lock,
  tournamentName,
}: {
  lock: ReturnType<typeof deriveLockStatus>;
  tournamentName: string | null;
}) {
  if (lock.state === 'no-tournament') {
    // No banner — the empty state handles messaging.
    return null;
  }
  if (lock.state === 'locked') {
    return (
      <div className="alert alert-warn" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <strong>🔒 Picks are locked.</strong>
        <span style={{ color: 'inherit', opacity: 0.85, fontSize: '0.85rem' }}>
          {tournamentName
            ? `${tournamentName} is in progress. All foursomes are now visible below.`
            : 'Tournament is in progress.'}
        </span>
      </div>
    );
  }
  if (lock.state === 'open-no-deadline') {
    return (
      <div className="alert alert-info">
        <strong>🔓 Picks open.</strong>{' '}
        Deadline TBD — we&rsquo;ll lock picks when the tournament starts.
      </div>
    );
  }
  // open with deadline
  const deadline = lock.deadline;
  const ms       = deadline.getTime() - Date.now();
  const inPast   = ms <= 0;
  return (
    <div className="alert alert-info" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
      <strong>🔓 Picks open.</strong>
      <span style={{ color: 'inherit', opacity: 0.85, fontSize: '0.85rem' }}>
        Lock {inPast ? 'pending' : 'in'} {' '}
        {!inPast && relativeFromNow(deadline)} —{' '}
        {deadline.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.
      </span>
    </div>
  );
}

function ActiveTournamentSection({
  tournament,
  myPick,
  leaderboard,
  picksByUser,
  revealPicks,
  currentUserId,
  slug,
}: {
  tournament: any;
  myPick: any;
  leaderboard: any[];
  picksByUser: Map<string, any>;
  revealPicks: boolean;
  currentUserId: string;
  slug: string;
}) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div style={{ minWidth: 0 }}>
          {tournament.type === 'major' && (
            <div className="major-badge" style={{ marginBottom: '0.5rem' }}>🏆 Major Championship</div>
          )}
          <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.4rem', fontWeight: 700 }}>
            {tournament.name}
          </h2>
          {tournament.course_name && (
            <p style={{ color: 'var(--slate-mid)', fontSize: '0.875rem', marginTop: '0.2rem' }}>
              {tournament.course_name}
            </p>
          )}
        </div>
        <span className="badge badge-live">🔴 Live</span>
      </div>

      {/* My pick summary (always visible to me, even pre-lock) */}
      {myPick ? (
        <div className="card" style={{ marginBottom: '1rem', borderLeft: '4px solid var(--green-mid)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
            <p style={{ fontWeight: 700, fontSize: '0.875rem' }}>My Pick</p>
            <Link href={`/league/${slug}/picks`} className="btn btn-ghost btn-sm">
              {revealPicks ? 'Review' : 'Edit'}
            </Link>
          </div>
          <div style={{ display: 'flex', flexFlow: 'row wrap', gap: '0.5rem' }}>
            {[myPick.golfer_1, myPick.golfer_2, myPick.golfer_3, myPick.golfer_4].map((g: any, i: number) => g && (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: '0.4rem',
                fontSize: '0.85rem', flex: '1 1 220px', minWidth: 0,
              }}>
                <span className={`badge ${i < 2 ? 'badge-green' : 'badge-brass'}`} style={{ fontSize: '0.62rem', flexShrink: 0 }}>
                  {i < 2 ? 'Top' : 'DH'}
                </span>
                <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {g.name}
                </span>
                <span style={{ color: 'var(--slate-mid)', fontSize: '0.78rem', flexShrink: 0 }}>
                  {g.owgr_rank ? `#${g.owgr_rank}` : 'Unranked'}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="alert alert-warn" style={{ marginBottom: '1rem' }}>
          ⚠️ You haven&rsquo;t submitted picks for this tournament yet.{' '}
          <Link href={`/league/${slug}/picks`} style={{ fontWeight: 700, color: 'inherit' }}>Submit now →</Link>
        </div>
      )}

      {/* Leaderboard */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="lb-table">
          <thead>
            <tr>
              <th style={{ width: 48 }}>#</th>
              <th>Player</th>
              <th className="hide-mobile">Golfers</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            {leaderboard.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ textAlign: 'center', padding: '3rem', color: 'var(--slate-mid)' }}>
                  No picks submitted yet — be the first!
                </td>
              </tr>
            ) : leaderboard.map((r: any, i: number) => {
              const rowPick = picksByUser.get(r.user_id);
              const isMe    = r.user_id === currentUserId;
              // Show foursome inline only after lock OR if it's the current user's own pick.
              const canReveal = revealPicks || isMe;
              return (
                <LeaderboardRow
                  key={r.user_id}
                  result={r}
                  pick={rowPick}
                  index={i}
                  isMe={isMe}
                  reveal={canReveal && !!rowPick}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      {!revealPicks && leaderboard.length > 0 && (
        <p style={{ marginTop: '0.5rem', fontSize: '0.78rem', color: 'var(--slate-light)', textAlign: 'right' }}>
          🔒 Other players&rsquo; foursomes will appear once picks lock.
        </p>
      )}
    </div>
  );
}

function LeaderboardRow({
  result, pick, index, isMe, reveal,
}: {
  result: any;
  pick:   any;
  index:  number;
  isMe:   boolean;
  reveal: boolean;
}) {
  // The reveal block is a native <details> sitting inside the same
  // table row's name cell — no JS needed. When `reveal === false` we
  // show the row but skip the disclosure.

  return (
    <>
      <tr className={`rank-${index + 1}`}>
        <td><span className="rank-num">{result.rank ?? index + 1}</span></td>
        <td>
          <strong style={{ fontSize: '0.95rem' }}>{result.profile?.display_name ?? 'Player'}</strong>
          {isMe && <span style={{ marginLeft: '0.4rem', fontSize: '0.72rem', color: 'var(--brass)' }}>← you</span>}
          {reveal && pick && (
            <details style={{ marginTop: '0.35rem' }}>
              <summary style={{
                fontSize: '0.72rem', color: 'var(--slate-mid)', cursor: 'pointer',
                listStyle: 'revert',
              }}>
                Show foursome
              </summary>
              <div style={{
                marginTop: '0.4rem', display: 'flex', flexDirection: 'column',
                gap: '0.25rem', fontSize: '0.78rem',
              }}>
                {[pick.golfer_1, pick.golfer_2, pick.golfer_3, pick.golfer_4].map((g: any, gi: number) => g && (
                  <div key={gi} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <span className={`badge ${gi < 2 ? 'badge-green' : 'badge-brass'}`} style={{ fontSize: '0.58rem' }}>
                      {gi < 2 ? 'Top' : 'DH'}
                    </span>
                    <span style={{ fontWeight: 600, color: 'var(--slate)' }}>{g.name}</span>
                    <span style={{ color: 'var(--slate-mid)', fontSize: '0.72rem' }}>
                      {g.owgr_rank ? `#${g.owgr_rank}` : 'Unranked'}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </td>
        <td className="hide-mobile" style={{ fontSize: '0.78rem', color: 'var(--slate-mid)' }}>
          {result.counting_golfers?.length ? `Top ${result.counting_golfers.length} counting` : '—'}
        </td>
        <td style={{ textAlign: 'right' }}>
          <strong className={result.total_score < 0 ? 'score-under' : result.total_score > 0 ? 'score-over' : 'score-even'}>
            {formatScore(result.total_score)}
          </strong>
        </td>
      </tr>
    </>
  );
}

function NoActiveTournamentSection({
  empty,
  isCommissioner,
  nextTournament,
  slug,
}: {
  empty: ReturnType<typeof deriveLeagueEmptyState>;
  isCommissioner: boolean;
  nextTournament: any;
  slug: string;
}) {
  // ── Solo-commissioner: someone just made the league. Highest-priority message.
  if (empty === 'solo-commissioner') {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '3rem 2rem' }}>
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>👋</div>
        <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.3rem', marginBottom: '0.5rem' }}>
          Just you so far!
        </h3>
        <p style={{ color: 'var(--slate-mid)', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
          Share the invite link in the sidebar to get your buddies in.
          Once 2+ players have joined, picks come alive on tournament week.
        </p>
        {nextTournament && (
          <p style={{ color: 'var(--slate-light)', fontSize: '0.85rem' }}>
            Next event: <strong>{nextTournament.name}</strong>{' · '}
            {new Date(nextTournament.start_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}
          </p>
        )}
      </div>
    );
  }
  // ── No tournament data at all.
  if (empty === 'no-tournament-no-upcoming') {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '3rem 2rem' }}>
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🗓️</div>
        <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.3rem', marginBottom: '0.5rem' }}>
          No tournaments scheduled yet
        </h3>
        <p style={{ color: 'var(--slate-mid)', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
          {isCommissioner
            ? 'The schedule sync hasn’t run. Head to admin to populate the season.'
            : 'Check back soon — your commissioner will populate the schedule.'}
        </p>
        {isCommissioner && (
          <Link href={`/league/${slug}/admin`} className="btn btn-primary">
            Open Admin →
          </Link>
        )}
      </div>
    );
  }
  // ── There IS an upcoming event — invite people to pick.
  // (no-tournament-but-upcoming OR null fallthrough)
  return (
    <div className="card" style={{ textAlign: 'center', padding: '3rem 2rem' }}>
      <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🗓️</div>
      <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.3rem', marginBottom: '0.5rem' }}>
        No Active Tournament
      </h3>
      <p style={{ color: 'var(--slate-mid)', marginBottom: '1.5rem' }}>
        {nextTournament
          ? `Next: ${nextTournament.name} — ${new Date(nextTournament.start_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`
          : 'Check back soon.'}
      </p>
      {nextTournament && (
        <Link href={`/league/${slug}/picks`} className="btn btn-primary">
          Submit Picks for {nextTournament.name} →
        </Link>
      )}
    </div>
  );
}

function SoloCommissionerCard({ isCommissioner }: { isCommissioner: boolean }) {
  return (
    <div className="alert alert-info">
      <strong>{isCommissioner ? 'Heads-up:' : '👋'}</strong>{' '}
      You&rsquo;re the only player here so far.{' '}
      {isCommissioner
        ? 'Use the invite link in the sidebar to get your buddies in.'
        : 'Standings will get more interesting once more friends join.'}
    </div>
  );
}

// ── Tiny formatter — keep here so we don't pull a dep just for this
function relativeFromNow(d: Date): string {
  const ms = d.getTime() - Date.now();
  const past = ms < 0;
  const abs  = Math.abs(ms);
  const min  = Math.floor(abs / 60_000);
  const hr   = Math.floor(min / 60);
  const day  = Math.floor(hr / 24);
  let label: string;
  if (day >= 1) label = `${day}d ${hr % 24}h`;
  else if (hr >= 1) label = `${hr}h ${min % 60}m`;
  else if (min >= 1) label = `${min}m`;
  else label = '<1m';
  return past ? `${label} ago` : label;
}
