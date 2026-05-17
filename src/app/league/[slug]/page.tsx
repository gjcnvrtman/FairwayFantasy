import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import {
  getLeagueBySlug,
  getLeagueMembers,
  getActiveTournamentInRange,
  getFantasyLeaderboard,
  getUpcomingTournamentsInRange,
  getPicksForTournament,
  getScoresForTournament,
  getTournamentLeaderboard,
  getCompletedTournamentsInRange,
  getFantasyResultsForTournaments,
} from '@/lib/db/queries';
import { computeLeagueMoney, formatMoney } from '@/lib/money';
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

  // League window — used by every "what tournaments count for this
  // league" query. Stored as TIMESTAMPTZ → string when serialized.
  const lgStart = league.start_date ? String(league.start_date) : null;
  const lgEnd   = league.end_date   ? String(league.end_date)   : null;

  const [members, activeTournament, upcoming, completedTournaments] = await Promise.all([
    getLeagueMembers(league.id),
    getActiveTournamentInRange(lgStart, lgEnd),
    getUpcomingTournamentsInRange(lgStart, lgEnd, 4),
    getCompletedTournamentsInRange(lgStart, lgEnd),
  ]);

  // Money summary for the sidebar card: per-user net across every
  // completed in-range tournament. Pulled in parallel below where
  // we already know which tournaments are in scope.
  const completedIds   = completedTournaments.map(t => t.id);
  const completedResults = await getFantasyResultsForTournaments(
    league.id, completedIds,
  );
  const memberIds      = members.map((m: any) => m.user_id);
  const betAmount      = Number(league.weekly_bet_amount ?? 0);
  // Group the result rows by tournament so we can pass an ordered
  // array into computeLeagueMoney that matches completedTournaments.
  const resultsByTourn = new Map<string, Array<{ user_id: string; rank: number | null }>>();
  for (const r of completedResults) {
    if (!resultsByTourn.has(r.tournament_id)) resultsByTourn.set(r.tournament_id, []);
    resultsByTourn.get(r.tournament_id)!.push({ user_id: r.user_id, rank: r.rank });
  }
  const moneySummary = computeLeagueMoney({
    memberIds,
    tournaments: completedTournaments.map(t => ({
      memberIds:  [],   // overwritten inside computeLeagueMoney
      betAmount,
      results:    resultsByTourn.get(t.id) ?? [],
    })),
  });

  const [leaderboard, allPicks, scoresRows, tournamentLeaders] = activeTournament
    ? await Promise.all([
        getFantasyLeaderboard(league.id, activeTournament.id),
        getPicksForTournament(league.id, activeTournament.id),
        getScoresForTournament(activeTournament.id),
        getTournamentLeaderboard(activeTournament.id, 25),
      ])
    : [[], [], [], []];

  // Build a per-user pick map so the leaderboard rows can render the
  // foursome inline (post-lock) without an extra query per row.
  const picksByUser = new Map<string, any>();
  for (const p of allPicks) picksByUser.set(p.user_id, p);
  const myPick = picksByUser.get(user.id) ?? null;

  // Build a per-golfer scores map so the leaderboard can show each
  // golfer's status (active / missed_cut / withdrawn / etc.) alongside
  // their fantasy score from fantasy_results.golfer_N_score.
  const scoresByGolferId = new Map<string, any>();
  for (const s of scoresRows) scoresByGolferId.set(s.golfer_id, s);

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
                  scoresByGolferId={scoresByGolferId}
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

              {/* Tournament leaderboard — top 25 of the actual PGA field.
                  Replaces the previous "Season Standings" + "League Roster"
                  sidebar cards (removed 2026-05-17). Shows everyone in the
                  field regardless of whether they were picked, so the
                  sidebar is useful even when your foursome flames out. */}
              {activeTournament && (
                <TournamentLeaderboardCard leaders={tournamentLeaders} />
              )}

              {/* League money card — cumulative $ won/lost per user
                  across every completed tournament inside the league
                  window. Always rendered when the league has played
                  at least one tournament; empty-state copy otherwise. */}
              <LeagueMoneyCard
                totals={moneySummary.totals}
                membersById={Object.fromEntries(members.map((m: any) => [m.user_id, m]))}
                currentUserId={user.id}
                betAmount={betAmount}
                tournamentCount={completedTournaments.length}
              />


              {/* Invite — client component, lifted out of the server tree
                  so the copy button's onClick actually works. Bug #4.9. */}
              <InviteCard
                inviteUrl={inviteUrl}
                invitePath={invitePath}
                slug={league.slug}
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
  scoresByGolferId,
  revealPicks,
  currentUserId,
  slug,
}: {
  tournament: any;
  myPick: any;
  leaderboard: any[];
  picksByUser: Map<string, any>;
  scoresByGolferId: Map<string, any>;
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

      {/* My-pick preview card removed 2026-05-17 — the picks page is one
          click away via the hero CTA and the post-lock fantasy leaderboard
          below already reveals every user's foursome inline. Keep only the
          missing-pick warning so the user is nudged when they haven't
          submitted yet. */}
      {!myPick && (
        <div className="alert alert-warn" style={{ marginBottom: '1rem' }}>
          ⚠️ You haven&rsquo;t submitted picks for this tournament yet.{' '}
          <Link href={`/league/${slug}/picks`} style={{ fontWeight: 700, color: 'inherit' }}>Submit now →</Link>
        </div>
      )}

      {/* Leaderboard — always-expanded cards. Each card shows the user's
          combined fantasy score on top, then their 4 picked golfers
          below with per-golfer fantasy score (post-rules) + status badge
          (MC / WD / DQ when applicable). The 3 counting toward the
          combined score are marked with ✓; the dropped 4th is dimmed. */}
      {leaderboard.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '3rem', color: 'var(--slate-mid)' }}>
          No picks submitted yet — be the first!
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {(() => {
            // Post-cut surface: once the cut has been made (or the
            // tournament is complete), the leaderboard row appends a
            // "Missed cut penalties" section so users can see exactly
            // which of their picks contribute the flat +1 penalty.
            //
            // We OR three signals so a partial sync-state can't hide
            // the section: (a) tournament.status explicitly says
            // cut_made/complete, OR (b) at least one golfer in the
            // field has been classified missed_cut — which can only
            // happen post-cut. Belt-and-suspenders for tournaments
            // where ESPN doesn't return a cut_score (covers the
            // 2026-05 PGA Championship's status-stuck-at-active case).
            const tournamentSaysPostCut =
              tournament.status === 'cut_made' || tournament.status === 'complete';
            const dataSaysPostCut = Array
              .from(scoresByGolferId.values())
              .some((s: any) => s?.status === 'missed_cut');
            const postCut = tournamentSaysPostCut || dataSaysPostCut;
            return leaderboard.map((r: any, i: number) => {
              const rowPick = picksByUser.get(r.user_id);
              const isMe    = r.user_id === currentUserId;
              // Pre-lock privacy: hide other players' foursomes. The
              // leaderboard generally only renders post-lock anyway, but
              // guard so an unlocked state still respects privacy.
              const canReveal = revealPicks || isMe;
              return (
                <LeaderboardRow
                  key={r.user_id}
                  result={r}
                  pick={rowPick}
                  index={i}
                  isMe={isMe}
                  reveal={canReveal && !!rowPick}
                  scoresByGolferId={scoresByGolferId}
                  postCut={postCut}
                />
              );
            });
          })()}
        </div>
      )}

      {!revealPicks && leaderboard.length > 0 && (
        <p style={{ marginTop: '0.5rem', fontSize: '0.78rem', color: 'var(--slate-light)', textAlign: 'right' }}>
          🔒 Other players&rsquo; foursomes will appear once picks lock.
        </p>
      )}
    </div>
  );
}

function LeaderboardRow({
  result, pick, index, isMe, reveal, scoresByGolferId, postCut,
}: {
  result: any;
  pick:   any;
  index:  number;
  isMe:   boolean;
  reveal: boolean;
  scoresByGolferId: Map<string, any>;
  /** True once tournament.status flips to cut_made/complete — enables
   *  the missed-cut summary section under the foursome rows. */
  postCut: boolean;
}) {
  const totalClass =
    result.total_score < 0 ? 'score-under'
    : result.total_score > 0 ? 'score-over' : 'score-even';

  // counting_golfers is a Postgres int[] of slot indexes (1..4) that
  // contribute to the user's combined fantasy score. computeLeagueResults
  // picks the best 3 of 4 per pick after applyFantasyRules.
  const counting = new Set<number>(result.counting_golfers ?? []);

  return (
    <div className={`card lb-card rank-${index + 1}`} style={{
      padding: '0.9rem 1rem',
      borderLeft: isMe ? '4px solid var(--brass)' : undefined,
    }}>
      {/* Header: rank + name + combined score */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '0.75rem', flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', minWidth: 0 }}>
          <span className="rank-num" style={{ flexShrink: 0 }}>{result.rank ?? index + 1}</span>
          <strong style={{ fontSize: '1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {result.profile?.display_name ?? 'Player'}
          </strong>
          {isMe && <span style={{ fontSize: '0.72rem', color: 'var(--brass)', flexShrink: 0 }}>← you</span>}
        </div>
        <strong className={totalClass} style={{ fontSize: '1.15rem', flexShrink: 0 }}>
          {formatScore(result.total_score)}
        </strong>
      </div>

      {/* Foursome list — always visible when reveal permitted */}
      {reveal && pick && (
        <div style={{
          marginTop: '0.6rem',
          paddingTop: '0.6rem',
          borderTop: '1px solid var(--cream-dark)',
          display: 'flex', flexDirection: 'column', gap: '0.3rem',
        }}>
          {[1, 2, 3, 4]
            .map(slot => ({
              slot,
              g: pick[`golfer_${slot}`],
              fantasy: result[`golfer_${slot}_score`] as number | null,
              missedCut: scoresByGolferId.get(pick[`golfer_${slot}`]?.id)?.status === 'missed_cut',
            }))
            .filter(e => e.g)
            // Sort:
            //   1. Cut survivors first (status='active'/'complete'/etc.)
            //   2. Missed-cut golfers last — they don't count toward
            //      top-3 even when their flat +1 penalty would
            //      numerically beat an active golfer's score, so they
            //      should fall out of the per-golfer ordering entirely
            //      and surface at the bottom of the list.
            //   3. Within each group, lower fantasy = better (golf
            //      scoring). Nulls (un-scored / WD / DQ) go last.
            .sort((a, b) => {
              if (a.missedCut !== b.missedCut) return a.missedCut ? 1 : -1;
              return (a.fantasy ?? Infinity) - (b.fantasy ?? Infinity);
            })
            .map(({ slot, g, fantasy }) => {
            const isCounting = counting.has(slot);
            const scoreRow   = scoresByGolferId.get(g.id);
            const status     = scoreRow?.status as string | undefined;
            const isMC       = status === 'missed_cut';
            const isWD       = status === 'withdrawn';
            const isDQ       = status === 'disqualified';
            const fClass =
              fantasy == null ? 'score-even'
              : fantasy < 0 ? 'score-under'
              : fantasy > 0 ? 'score-over' : 'score-even';
            return (
              <div key={slot} style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                fontSize: '0.85rem',
                opacity: isCounting ? 1 : 0.5,
              }}>
                <span style={{
                  width: 14, flexShrink: 0, fontSize: '0.85rem',
                  color: isCounting ? 'var(--green-mid)' : 'var(--slate-light)',
                }} aria-label={isCounting ? 'counting' : 'dropped'}>
                  {isCounting ? '✓' : '·'}
                </span>
                <span className={`badge ${slot <= 2 ? 'badge-green' : 'badge-brass'}`} style={{ fontSize: '0.58rem', flexShrink: 0 }}>
                  {slot <= 2 ? 'Top' : 'DH'}
                </span>
                <span style={{
                  fontWeight: 600, color: 'var(--slate)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  flex: '1 1 auto', minWidth: 0,
                }}>
                  {g.name}
                </span>
                <span style={{ color: 'var(--slate-mid)', fontSize: '0.72rem', flexShrink: 0 }}>
                  {g.owgr_rank ? `#${g.owgr_rank}` : 'Unranked'}
                </span>
                {(isMC || isWD || isDQ) && (
                  <span
                    className="badge"
                    style={{
                      fontSize: '0.58rem',
                      flexShrink: 0,
                      background: '#fef3c7',  // matches --brass-pale
                      color: '#92400e',
                      border: '1px solid #fcd34d',
                    }}
                    title={isMC ? 'Missed cut' : isWD ? 'Withdrew' : 'Disqualified'}
                  >
                    {isMC ? 'MC' : isWD ? 'WD' : 'DQ'}
                  </span>
                )}
                <strong className={fClass} style={{ fontSize: '0.9rem', flexShrink: 0, width: '3rem', textAlign: 'right' }}>
                  {fantasy == null ? '—' : formatScore(fantasy)}
                </strong>
              </div>
            );
          })}

          {/* Missed-cut penalty section — visible once the cut has
              been made. Shows one row per missed-cut golfer in the
              user's foursome (each contributing +1 to the total via
              the penalty bucket in computeLeagueResults), or a single
              "No players missed cut" summary line when nobody missed.
              Total reconciles: top-3 sum + (rows shown here × +1). */}
          {reveal && pick && postCut && (() => {
            const mcPicks = [1, 2, 3, 4]
              .map(slot => ({ slot, g: pick[`golfer_${slot}`] }))
              .filter(e => {
                if (!e.g) return false;
                const s = scoresByGolferId.get(e.g.id);
                return s?.status === 'missed_cut';
              });
            return (
              <div style={{
                marginTop: '0.5rem',
                paddingTop: '0.5rem',
                borderTop: '1px dashed var(--cream-dark)',
                display: 'flex', flexDirection: 'column', gap: '0.25rem',
              }}>
                {mcPicks.length === 0 ? (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                    fontSize: '0.82rem', color: 'var(--slate-mid)',
                    fontStyle: 'italic',
                  }}>
                    <span style={{ flex: '1 1 auto' }}>No players missed cut</span>
                    <strong className="score-even" style={{ fontSize: '0.9rem', flexShrink: 0, width: '3rem', textAlign: 'right' }}>
                      0
                    </strong>
                  </div>
                ) : (
                  mcPicks.map(({ slot, g }) => (
                    <div key={`mc-${slot}`} style={{
                      display: 'flex', alignItems: 'center', gap: '0.5rem',
                      fontSize: '0.82rem', color: 'var(--slate)',
                    }}>
                      <span style={{
                        flex: '1 1 auto',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        Missed cut · {g.name}
                      </span>
                      <strong className="score-over" style={{ fontSize: '0.9rem', flexShrink: 0, width: '3rem', textAlign: 'right' }}>
                        +1
                      </strong>
                    </div>
                  ))
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
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

// ── Tournament leaderboard — top 25 of the actual PGA field ────
// Drives the league sidebar after the dashboard redesign on 2026-05-17.
// Sourced via `getTournamentLeaderboard` (scores ⨝ golfers, ordered
// by score_to_par asc, limit 25). Rows include status badges for
// non-active golfers (MC/WD/DQ) so the sidebar reads honestly during
// cut day. Pre-round-1 (no score_to_par anywhere) the query returns
// 0 rows and we show an empty-state hint.

interface TournamentLeader {
  golfer_id:     string;
  golfer_name:   string;
  owgr_rank:     number | null;
  country:       string | null;
  score_to_par:  number | null;
  position:      string | null;
  status:        'active' | 'missed_cut' | 'withdrawn' | 'disqualified' | 'complete';
  total_strokes: number | null;
}

function TournamentLeaderboardCard({ leaders }: { leaders: TournamentLeader[] }) {
  if (!leaders.length) {
    return (
      <div className="card">
        <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1rem', fontWeight: 700, marginBottom: '0.6rem' }}>
          Tournament Leaderboard
        </h3>
        <p style={{ color: 'var(--slate-mid)', fontSize: '0.875rem' }}>
          No scores yet — leaderboard populates once round 1 tees off.
        </p>
      </div>
    );
  }
  return (
    <div className="card">
      <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1rem', fontWeight: 700, marginBottom: '0.2rem' }}>
        Tournament Leaderboard
      </h3>
      <p style={{ color: 'var(--slate-light)', fontSize: '0.72rem', marginBottom: '0.8rem' }}>
        Top {leaders.length} in the field
      </p>
      <div>
        {leaders.map((g, i) => {
          const posLabel = g.position?.trim() || String(i + 1);
          const cutLabel =
            g.status === 'missed_cut'   ? 'MC'
          : g.status === 'withdrawn'    ? 'WD'
          : g.status === 'disqualified' ? 'DQ'
          : null;
          return (
            <div key={g.golfer_id} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '0.4rem 0',
              borderBottom: i < leaders.length - 1 ? '1px solid var(--cream-dark)' : 'none',
              opacity: cutLabel ? 0.65 : 1,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', minWidth: 0, flex: 1 }}>
                <span style={{
                  fontFamily: 'monospace', fontWeight: 700, fontSize: '0.78rem',
                  width: 26, flexShrink: 0, color: 'var(--slate-mid)', textAlign: 'right',
                }}>
                  {posLabel}
                </span>
                <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <span style={{
                    fontSize: '0.85rem', fontWeight: 500,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {g.golfer_name}
                  </span>
                  {(g.owgr_rank || cutLabel) && (
                    <span style={{ fontSize: '0.7rem', color: 'var(--slate-mid)', display: 'flex', gap: '0.4rem' }}>
                      {g.owgr_rank && <span>OWGR #{g.owgr_rank}</span>}
                      {cutLabel && <span style={{ color: 'var(--red)', fontWeight: 700 }}>{cutLabel}</span>}
                    </span>
                  )}
                </div>
              </div>
              <strong className={
                g.score_to_par === null      ? 'score-even'
              : g.score_to_par < 0           ? 'score-under'
              : g.score_to_par > 0           ? 'score-over'
              : 'score-even'
              } style={{ fontSize: '0.9rem', flexShrink: 0, marginLeft: '0.5rem' }}>
                {formatScore(g.score_to_par)}
              </strong>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── League money card ─────────────────────────────────────────
// Sidebar summary of cumulative $ won/lost per league member across
// every completed tournament inside the league's window. Empty-state
// before any tournament has completed. Ordered winners-first so the
// reader sees the standings at a glance.

interface MoneyTotal { user_id: string; amount: number; }
interface MemberLite { user_id: string; profile?: { display_name?: string } | null; }

function LeagueMoneyCard({
  totals, membersById, currentUserId, betAmount, tournamentCount,
}: {
  totals:          MoneyTotal[];
  membersById:     Record<string, MemberLite>;
  currentUserId:   string;
  betAmount:       number;
  tournamentCount: number;
}) {
  const ranked = [...totals].sort((a, b) => b.amount - a.amount);
  return (
    <div className="card">
      <h3 style={{
        fontFamily: "'Playfair Display', serif",
        fontSize: '1rem', fontWeight: 700, marginBottom: '0.2rem',
      }}>
        Money — Season
      </h3>
      <p style={{ color: 'var(--slate-light)', fontSize: '0.72rem', marginBottom: '0.8rem' }}>
        {tournamentCount === 0
          ? `No tournaments completed yet · $${betAmount.toFixed(2)} per event`
          : `${tournamentCount} tournament${tournamentCount === 1 ? '' : 's'} completed · $${betAmount.toFixed(2)} per event`}
      </p>
      {tournamentCount === 0 ? (
        <p style={{ color: 'var(--slate-mid)', fontSize: '0.85rem', fontStyle: 'italic' }}>
          Money totals populate after the first in-window tournament finishes.
        </p>
      ) : (
        <div>
          {ranked.map((t, i) => {
            const m = membersById[t.user_id];
            const name = m?.profile?.display_name ?? 'Player';
            const isMe = t.user_id === currentUserId;
            const cls  =
              t.amount > 0 ? 'score-under'   // green for winners
            : t.amount < 0 ? 'score-over'    // red for losers
            : 'score-even';
            return (
              <div key={t.user_id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '0.45rem 0',
                borderBottom: i < ranked.length - 1 ? '1px solid var(--cream-dark)' : 'none',
                fontSize: '0.88rem',
              }}>
                <span style={{
                  fontWeight: isMe ? 700 : 500,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  flex: '1 1 auto', minWidth: 0,
                }}>
                  {name}
                  {isMe && <span style={{ color: 'var(--brass)', marginLeft: '0.3rem', fontSize: '0.7rem' }}>you</span>}
                </span>
                <strong className={cls} style={{ fontSize: '0.95rem', flexShrink: 0 }}>
                  {formatMoney(t.amount)}
                </strong>
              </div>
            );
          })}
        </div>
      )}
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
