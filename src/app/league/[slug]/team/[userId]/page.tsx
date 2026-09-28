// /league/[slug]/team/[userId]?t=<tournamentId>&round=<1-4>
//
// Hole-by-hole scorecard for one member's team in one round. Linked
// from each row of the league leaderboard.
//
// Privacy: another member's team is visible only once picks have
// locked — the same rule the leaderboard uses to reveal foursomes
// (shouldRevealOtherPicks). Your own team is always visible.

import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import { getLeagueBySlug, getActiveTournamentInRange, isoOrNull, loadReplacements } from '@/lib/db/queries';
import { deriveLockStatus, shouldRevealOtherPicks } from '@/lib/league-dashboard';
import { formatScore } from '@/lib/scoring';
import {
  buildScorecardRows, defaultScorecardRound, parseRoundParam, formatToPar,
  HOLES, type TeamGolferInput, type HoleResult, type ScorecardRow,
} from '@/lib/team-scorecard';
import { teamShapeFor, teamSlots, pickGolferIds } from '@/lib/team-shape';
import Nav from '@/components/layout/Nav';
import { hasSeasonBets, seasonBetConfigFromLeague } from '@/lib/season-bets';
import AutoRefresh from '@/components/league/AutoRefresh';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Team Scorecard' };

interface Props {
  params:       { slug: string; userId: string };
  searchParams: { t?: string; round?: string };
}

export default async function TeamScorecardPage({ params, searchParams }: Props) {
  const user = await getCurrentUser();
  if (!user) redirect(`/auth/signin?redirect=/league/${params.slug}`);

  const league = await getLeagueBySlug(params.slug);
  if (!league) notFound();

  const membership = await db.selectFrom('league_members')
    .select('role')
    .where('league_id', '=', league.id)
    .where('user_id', '=', user.id)
    .executeTakeFirst();
  if (!membership) redirect(`/join/${params.slug}/${league.invite_code}`);

  const target = await db.selectFrom('league_members')
    .innerJoin('profiles', 'profiles.id', 'league_members.user_id')
    .select(['profiles.id', 'profiles.display_name'])
    .where('league_members.league_id', '=', league.id)
    .where('league_members.user_id', '=', params.userId)
    .executeTakeFirst();
  if (!target) notFound();

  const viewerProfile = await db.selectFrom('profiles')
    .select('display_name')
    .where('id', '=', user.id)
    .executeTakeFirst();

  // Tournament: explicit ?t= (must be on this league's schedule), else
  // the league's live tournament.
  const tournament = searchParams.t
    ? await db.selectFrom('tournaments')
        .innerJoin('league_tournaments', 'league_tournaments.tournament_id', 'tournaments.id')
        .selectAll('tournaments')
        .where('league_tournaments.league_id', '=', league.id)
        .where('tournaments.id', '=', searchParams.t)
        .executeTakeFirst() ?? null
    : await getActiveTournamentInRange(league.id, isoOrNull(league.start_date), isoOrNull(league.end_date));

  const backHref = `/league/${params.slug}`;
  const isMe = target.id === user.id;
  const teamName = isMe ? 'Your team' : `${target.display_name || 'Player'}’s team`;

  const shell = (body: React.ReactNode, sub?: string) => (
    <div className="page-shell">
      <Nav leagueSlug={params.slug} leagueName={league.name} userName={viewerProfile?.display_name}
           showSeasons={hasSeasonBets(seasonBetConfigFromLeague(league))} />
      <div className="t-hero" style={{ padding: '2.25rem 1.5rem' }}>
        <div className="container">
          <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.78rem', fontWeight: 700,
                      textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '0.4rem' }}>
            {tournament?.name ?? league.name}
          </p>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 'clamp(1.6rem,4vw,2.3rem)', fontWeight: 900 }}>
            {teamName}
          </h1>
          {sub && <p style={{ color: 'rgba(255,255,255,0.75)', marginTop: '0.35rem' }}>{sub}</p>}
        </div>
      </div>
      <div className="page-content">
        <div className="container">
          {body}
          <p style={{ marginTop: '1.25rem' }}>
            <Link href={backHref} style={{ color: 'var(--green-mid)', fontWeight: 600, textDecoration: 'none' }}>
              ← Back to leaderboard
            </Link>
          </p>
        </div>
      </div>
    </div>
  );

  const notice = (icon: string, title: string, text: string) => (
    <div className="card" style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
      <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>{icon}</div>
      <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.2rem', marginBottom: '0.4rem' }}>{title}</h3>
      <p style={{ color: 'var(--slate-mid)' }}>{text}</p>
    </div>
  );

  if (!tournament) {
    return shell(notice('⛳', 'No tournament in progress', 'Team scorecards appear once a tournament is underway.'));
  }

  const reveal = isMe || shouldRevealOtherPicks(deriveLockStatus({
    status:        tournament.status,
    pick_deadline: tournament.pick_deadline ? new Date(tournament.pick_deadline).toISOString() : null,
  }));
  if (!reveal) {
    return shell(notice('🔒', 'Teams are hidden until picks lock',
      'You can see every team’s scorecard once all picks are locked.'));
  }

  const pick = await db.selectFrom('picks')
    .selectAll()
    .where('league_id', '=', league.id)
    .where('tournament_id', '=', tournament.id)
    .where('user_id', '=', target.id)
    .executeTakeFirst();
  if (!pick) {
    return shell(notice('📝', 'No team submitted', 'This member doesn’t have picks for this tournament.'));
  }

  // 6-man on majors when the league chose it (migration 026).
  const shape = teamShapeFor(league, tournament);
  const SLOTS = teamSlots(shape);
  const slotGolferIds = pickGolferIds(pick, shape);
  const baseIds = slotGolferIds.filter((id): id is string => !!id);
  // This player's own WD swaps (migration 028).
  const swaps = (await loadReplacements([pick.id])).get(pick.id) ?? {};
  const lookupIds = [...new Set([...baseIds, ...Object.values(swaps).filter((id): id is string => !!id)])];

  const scoreRows = lookupIds.length === 0 ? [] : await db.selectFrom('scores')
    .selectAll()
    .where('tournament_id', '=', tournament.id)
    .where('golfer_id', 'in', lookupIds)
    .execute();
  const scoreByGolfer = new Map(scoreRows.map(s => [s.golfer_id, s]));

  const nameIds = lookupIds;
  const nameRows = nameIds.length === 0 ? [] : await db.selectFrom('golfers')
    .select(['id', 'name'])
    .where('id', 'in', nameIds)
    .execute();
  const nameById = new Map(nameRows.map(g => [g.id, g.name]));

  const result = await db.selectFrom('fantasy_results')
    .selectAll()
    .where('league_id', '=', league.id)
    .where('tournament_id', '=', tournament.id)
    .where('user_id', '=', target.id)
    .executeTakeFirst();
  const counting = new Set<number>((result?.counting_golfers as number[] | null) ?? []);

  const golfers: TeamGolferInput[] = [];
  SLOTS.forEach((slot, i) => {
    const baseId = slotGolferIds[i];
    if (!baseId) return;
    // Replacement after a WD: this player's replacement's card counts.
    const swapId = swaps[slot] ?? null;
    const effId = swapId ?? baseId;
    const eff = scoreByGolfer.get(effId);
    golfers.push({
      slot,
      name:             nameById.get(effId) ?? 'Unknown golfer',
      replacedFromName: swapId ? nameById.get(baseId) ?? null : null,
      status:           eff?.status ?? 'active',
      holesByRound:     [eff?.round_1_holes ?? null, eff?.round_2_holes ?? null,
                         eff?.round_3_holes ?? null, eff?.round_4_holes ?? null],
      tournamentToPar:  eff?.score_to_par ?? null,
      fantasyScore:     (result?.[`golfer_${slot}_score` as 'golfer_1_score'] as number | null) ?? null,
      counting:         counting.has(slot),
    });
  });

  const round = parseRoundParam(searchParams.round, defaultScorecardRound(golfers));
  const parByHole = (tournament.par_by_hole as number[] | null) ?? null;
  const rows = buildScorecardRows({ golfers, round, parByHole, topTierSlots: shape.topTier });
  const live = tournament.status !== 'complete';

  const sub = result?.total_score != null
    ? `Team total ${formatScore(result.total_score)}${result.rank ? ` · Rank ${result.rank}` : ''}`
    : undefined;

  const tabHref = (r: number) =>
    `/league/${params.slug}/team/${target.id}?t=${tournament.id}&round=${r}`;

  return shell(
    <>
      {live && <AutoRefresh seconds={120} />}

      <nav aria-label="Round" style={{ display: 'flex', gap: '0.4rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        {[1, 2, 3, 4].map(r => (
          <Link key={r} href={tabHref(r)} aria-current={r === round ? 'page' : undefined}
                className={`btn btn-sm ${r === round ? 'btn-primary' : 'btn-outline'}`}
                style={{ minWidth: '4.5rem' }}>
            Round {r}
          </Link>
        ))}
      </nav>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {rows.map(row => <GolferCard key={row.slot} row={row} parByHole={parByHole} />)}
      </div>

      <p style={{ marginTop: '1rem', fontSize: '0.78rem', color: 'var(--slate-mid)' }}>
        <Legend /> {live && '· Updates automatically every couple of minutes.'}
      </p>
    </>,
    sub,
  );
}

// ── Presentation ────────────────────────────────────────────

const RESULT_STYLE: Record<Exclude<HoleResult, null>, React.CSSProperties> = {
  eagle:  { background: 'var(--red)', color: 'white', borderRadius: '50%' },
  birdie: { boxShadow: 'inset 0 0 0 2px var(--red)', color: 'var(--red)', borderRadius: '50%' },
  par:    {},
  bogey:  { boxShadow: 'inset 0 0 0 2px var(--blue)', color: 'var(--blue)' },
  double: { background: 'var(--blue)', color: 'white' },
};

function Legend() {
  const item = (label: string, style: React.CSSProperties) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 10 }}>
      <span style={{ display: 'inline-block', width: 14, height: 14, ...style }} />{label}
    </span>
  );
  return (
    <>
      {item('Eagle+', RESULT_STYLE.eagle)}
      {item('Birdie', RESULT_STYLE.birdie)}
      {item('Bogey', RESULT_STYLE.bogey)}
      {item('Double+', RESULT_STYLE.double)}
    </>
  );
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  missed_cut:   { label: 'MC', cls: 'badge-red' },
  withdrawn:    { label: 'WD', cls: 'badge-red' },
  disqualified: { label: 'DQ', cls: 'badge-red' },
  complete:     { label: 'Final', cls: 'badge-gray' },
};

function GolferCard({ row, parByHole }: { row: ScorecardRow; parByHole: Array<number | null> | null }) {
  const badge = STATUS_BADGE[row.status];
  const toParCls = (n: number | null) =>
    n == null ? '' : n < 0 ? 'score-under' : n > 0 ? 'score-over' : 'score-even';
  const cell: React.CSSProperties = {
    minWidth: 30, height: 30, padding: 0, textAlign: 'center',
    fontSize: '0.82rem', fontVariantNumeric: 'tabular-nums',
  };
  const sumCell: React.CSSProperties = { ...cell, minWidth: 38, fontWeight: 700, background: 'var(--cream)' };
  // Header row keeps the table's dark header background.
  const sumHead: React.CSSProperties = { ...cell, minWidth: 38, color: 'white' };
  const holeCell = (v: number | null, result: HoleResult, key: number) => (
    <td key={key} style={cell}>
      {v == null ? '' : (
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 24, height: 24, ...(result ? RESULT_STYLE[result] : {}),
        }}>{v}</span>
      )}
    </td>
  );
  const nine = (start: number) => Array.from({ length: 9 }, (_, i) => start + i);
  const parSum = (start: number) =>
    parByHole && nine(start).every(i => parByHole[i] != null)
      ? nine(start).reduce((s, i) => s + (parByHole[i] as number), 0) : null;

  return (
    <section className="card" style={{ padding: 0, overflow: 'hidden', opacity: row.counting || row.holesPlayed === 0 ? 1 : 0.8 }}>
      <header style={{
        display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap',
        padding: '0.85rem 1.1rem', borderBottom: '1px solid var(--cream-dark)',
      }}>
        <span className={`badge ${row.tierLabel === 'Top tier' ? 'badge-green' : 'badge-brass'}`}>{row.tierLabel}</span>
        <strong style={{ fontSize: '1rem' }}>{row.name}</strong>
        {badge && <span className={`badge ${badge.cls}`}>{badge.label}</span>}
        {row.counting && <span className="badge badge-blue" title="Counts toward the team total">✓ Counting</span>}
        {row.replacedFromName && (
          <span style={{ fontSize: '0.78rem', color: 'var(--slate-mid)' }}>replaced {row.replacedFromName}</span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: '1rem', fontSize: '0.85rem' }}>
          <span>Round <strong className={toParCls(row.roundToPar)}>{formatToPar(row.roundToPar)}</strong>
            {row.holesPlayed > 0 && row.holesPlayed < HOLES && (
              <span style={{ color: 'var(--slate-mid)' }}> thru {row.holesPlayed}</span>
            )}
          </span>
          <span>Total <strong className={toParCls(row.tournamentToPar)}>{formatToPar(row.tournamentToPar)}</strong></span>
        </span>
      </header>

      {row.holesPlayed === 0 ? (
        <p style={{ padding: '0.9rem 1.1rem', margin: 0, fontSize: '0.85rem', color: 'var(--slate-mid)' }}>
          {row.status === 'missed_cut' ? 'Missed the cut — no score this round.'
            : row.status === 'withdrawn' ? 'Withdrew — no score this round.'
            : 'No holes played yet this round.'}
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="lb-table" style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th style={{ ...cell, textAlign: 'left', paddingLeft: '1.1rem' }}>Hole</th>
                {nine(0).map(i => <th key={i} style={cell}>{i + 1}</th>)}
                <th style={sumHead}>OUT</th>
                {nine(9).map(i => <th key={i} style={cell}>{i + 1}</th>)}
                <th style={sumHead}>IN</th>
                <th style={sumHead}>TOT</th>
              </tr>
            </thead>
            <tbody>
              {parByHole && (
                <tr>
                  <td style={{ ...cell, textAlign: 'left', paddingLeft: '1.1rem', color: 'var(--slate-mid)' }}>Par</td>
                  {nine(0).map(i => <td key={i} style={{ ...cell, color: 'var(--slate-mid)' }}>{parByHole[i] ?? ''}</td>)}
                  <td style={sumCell}>{parSum(0) ?? ''}</td>
                  {nine(9).map(i => <td key={i} style={{ ...cell, color: 'var(--slate-mid)' }}>{parByHole[i] ?? ''}</td>)}
                  <td style={sumCell}>{parSum(9) ?? ''}</td>
                  <td style={sumCell}>{parSum(0) != null && parSum(9) != null ? (parSum(0)! + parSum(9)!) : ''}</td>
                </tr>
              )}
              <tr>
                <td style={{ ...cell, textAlign: 'left', paddingLeft: '1.1rem', fontWeight: 600 }}>Score</td>
                {nine(0).map(i => holeCell(row.strokes[i], row.results[i], i))}
                <td style={sumCell}>{row.out ?? ''}</td>
                {nine(9).map(i => holeCell(row.strokes[i], row.results[i], i))}
                <td style={sumCell}>{row.in ?? ''}</td>
                <td style={sumCell}>{row.total ?? ''}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
