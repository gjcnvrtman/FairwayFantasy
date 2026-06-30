// ============================================================
// /predictions/current — upcoming PGA tournament + latest prediction
// run for it. Admin only (layout gate).
//
// Server component does the DB reads + composes the page. The single
// interactive piece (Run Predictions button) is the RunButton client
// component imported below.
// ============================================================

import Link from 'next/link';
import { db } from '@/lib/db';
import RunButton from './RunButton';
import EmailButton from './EmailButton';

export const dynamic = 'force-dynamic';  // always fetch fresh; admin tool, no caching
export const metadata = { title: 'Current — Predictions' };

interface TournamentRow {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: 'upcoming' | 'active' | 'cut_made' | 'complete';
  course_name: string | null;
  course_profile_id: string | null;
}

interface CourseProfileLite {
  id: string;
  name: string;
}

interface RunRow {
  id: string;
  started_at: string;
  completed_at: string | null;
  status: 'pending' | 'running' | 'complete' | 'failed';
  field_size: number | null;
  golfers_with_missing_stats: number | null;
  missing_inputs: unknown;
  error: string | null;
}

interface FoursomeRow {
  rank: number;
  top_tier_1_golfer_id: string;
  top_tier_2_golfer_id: string;
  dark_horse_1_golfer_id: string;
  dark_horse_2_golfer_id: string;
  projected_fantasy_score: string;
  confidence_score: string;
  risk_level: 'conservative' | 'balanced' | 'aggressive';
  estimated_ownership_pct: string | null;
  key_strengths: string[] | null;
  key_concerns: string[] | null;
  foursome_explanation: string | null;
}

async function loadUpcomingTournament(): Promise<TournamentRow | null> {
  const nowIso = new Date().toISOString();
  const next = await db.selectFrom('tournaments')
    .select(['id', 'name', 'start_date', 'end_date', 'status',
             'course_name', 'course_profile_id'])
    .where('start_date', '>=', nowIso)
    .where('type', 'in', ['regular', 'major'])
    .orderBy('start_date', 'asc')
    .limit(1)
    .executeTakeFirst();
  if (next) return next;
  return await db.selectFrom('tournaments')
    .select(['id', 'name', 'start_date', 'end_date', 'status',
             'course_name', 'course_profile_id'])
    .where('status', '=', 'active')
    .orderBy('start_date', 'desc')
    .limit(1)
    .executeTakeFirst() ?? null;
}

async function loadProfile(profileId: string): Promise<CourseProfileLite | null> {
  return (await db.selectFrom('course_profiles')
    .select(['id', 'name'])
    .where('id', '=', profileId)
    .executeTakeFirst()) ?? null;
}

async function loadLatestRun(tournamentId: string): Promise<{
  run: RunRow;
  foursomes: FoursomeRow[];
  golferNames: Map<string, string>;
} | null> {
  const run = await db.selectFrom('tournament_prediction_runs')
    .select(['id', 'started_at', 'completed_at', 'status',
             'field_size', 'golfers_with_missing_stats',
             'missing_inputs', 'error'])
    .where('tournament_id', '=', tournamentId)
    .orderBy('started_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!run) return null;

  const foursomes = await db.selectFrom('foursome_recommendations')
    .select(['rank', 'top_tier_1_golfer_id', 'top_tier_2_golfer_id',
             'dark_horse_1_golfer_id', 'dark_horse_2_golfer_id',
             'projected_fantasy_score', 'confidence_score', 'risk_level',
             'estimated_ownership_pct', 'key_strengths', 'key_concerns',
             'foursome_explanation'])
    .where('run_id', '=', run.id)
    .orderBy('rank', 'asc')
    .execute();

  // Resolve golfer names for display.
  const ids = new Set<string>();
  for (const f of foursomes) {
    ids.add(f.top_tier_1_golfer_id);
    ids.add(f.top_tier_2_golfer_id);
    ids.add(f.dark_horse_1_golfer_id);
    ids.add(f.dark_horse_2_golfer_id);
  }
  const names = ids.size > 0
    ? await db.selectFrom('golfers')
        .select(['id', 'name'])
        .where('id', 'in', Array.from(ids))
        .execute()
    : [];
  const nameMap = new Map(names.map(n => [n.id, n.name]));

  return { run, foursomes, golferNames: nameMap };
}

// ── UI helpers ──────────────────────────────────────────────

function fmtDateRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  return `${s.toLocaleDateString()} → ${e.toLocaleDateString()}`;
}

function riskBadgeColor(risk: string): string {
  if (risk === 'conservative') return '#3a8e5b';
  if (risk === 'aggressive') return '#cc7a3a';
  return '#3a6ea5';
}

// ── Page ────────────────────────────────────────────────────

export default async function CurrentPredictionsPage() {
  const tournament = await loadUpcomingTournament();

  if (!tournament) {
    return (
      <div>
        <h1 style={{ marginTop: 0 }}>No upcoming tournament</h1>
        <p>No PGA tournaments are upcoming or in progress. Check back closer to the next event.</p>
      </div>
    );
  }

  const profile = tournament.course_profile_id
    ? await loadProfile(tournament.course_profile_id)
    : null;

  const hasProfile = !!profile;
  const latest = hasProfile ? await loadLatestRun(tournament.id) : null;

  return (
    <div style={{ maxWidth: '1200px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '16px', marginBottom: '8px' }}>
        <h1 style={{ margin: 0, fontSize: '28px' }}>{tournament.name}</h1>
        <span style={{ color: '#666', fontSize: '14px' }}>
          {fmtDateRange(tournament.start_date, tournament.end_date)}
        </span>
      </div>
      <p style={{ color: '#555', marginTop: 0 }}>
        {/* Prefer the curated course_profiles.name over ESPN's
            tournaments.course_name. ESPN often leaves course_name
            NULL for upcoming events; the profile name is what we
            curated and is authoritative once linked. */}
        Course: {profile?.name ?? tournament.course_name ?? '(unknown)'}
      </p>

      {/* Profile state */}
      {!hasProfile ? (
        <div style={warningBox}>
          <strong>No course profile curated yet.</strong>
          <p style={{ margin: '8px 0' }}>
            The predictor needs course-fit fields (driving distance importance,
            approach difficulty, etc.) before it can score golfers for this
            tournament.
          </p>
          <Link
            href={`/predictions/courses/new?tournament_id=${tournament.id}&course_name=${encodeURIComponent(tournament.course_name ?? '')}`}
            style={primaryButton}
          >
            Curate course profile
          </Link>
        </div>
      ) : (
        <>
          <div style={infoBox}>
            <strong>Course profile:</strong> {profile?.name}{' '}
            <Link href={`/predictions/courses/${profile?.id}`} style={{ marginLeft: '8px' }}>
              edit
            </Link>
          </div>

          {/* Run trigger */}
          <div style={{
            margin: '24px 0',
            padding: '20px',
            backgroundColor: '#fff',
            border: '1px solid #ddd',
            borderRadius: '8px',
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '12px',
            }}>
              <strong style={{ fontSize: '16px' }}>Prediction run</strong>
              <div style={{ display: 'flex', gap: '8px' }}>
                {latest?.run && latest.run.status === 'complete' && (
                  <EmailButton runId={latest.run.id} />
                )}
                <RunButton tournamentId={tournament.id} />
              </div>
            </div>
            {latest?.run ? (
              <div style={{ color: '#555', fontSize: '14px' }}>
                Last run: <strong>{new Date(latest.run.started_at).toLocaleString()}</strong>
                {' · '}status: <strong>{latest.run.status}</strong>
                {latest.run.field_size && (
                  <> · field: <strong>{latest.run.field_size}</strong></>
                )}
                {latest.run.golfers_with_missing_stats != null
                  && latest.run.golfers_with_missing_stats > 0 && (
                  <> · <span style={{ color: '#c66' }}>
                    {latest.run.golfers_with_missing_stats} golfer(s) running on partial data
                  </span></>
                )}
                {latest.run.error && (
                  <div style={{ color: '#c33', marginTop: '8px' }}>
                    Error: {latest.run.error}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ color: '#888', fontSize: '14px' }}>
                No runs yet. Click &ldquo;Run predictions&rdquo; above to produce the top 5 foursomes.
              </div>
            )}
          </div>

          {/* Top 5 foursomes */}
          {latest?.run.status === 'complete' && latest.foursomes.length > 0 && (
            <>
              <h2 style={{ marginTop: '32px' }}>Top 5 foursomes</h2>
              <p style={{ color: '#666', fontSize: '14px', marginTop: 0 }}>
                Lower projected score = better (it&apos;s golf). These are model
                predictions, not guarantees.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {latest.foursomes.map(f => (
                  <FoursomeCard
                    key={f.rank}
                    f={f}
                    nameMap={latest.golferNames}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ── Foursome card (server-rendered) ───────────────────────

function FoursomeCard({ f, nameMap }: {
  f: FoursomeRow;
  nameMap: Map<string, string>;
}) {
  const projected = Number(f.projected_fantasy_score).toFixed(1);
  const confidence = (Number(f.confidence_score) * 100).toFixed(0);
  const ownership = f.estimated_ownership_pct
    ? Number(f.estimated_ownership_pct).toFixed(1) + '%'
    : null;

  return (
    <div style={{
      backgroundColor: '#fff',
      border: '1px solid #ddd',
      borderRadius: '8px',
      padding: '20px',
      display: 'grid',
      gridTemplateColumns: 'auto 1fr',
      gap: '16px',
    }}>
      {/* Rank */}
      <div style={{
        fontSize: '40px',
        fontWeight: 800,
        color: '#888',
        minWidth: '48px',
      }}>
        #{f.rank}
      </div>

      <div>
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '8px',
          marginBottom: '12px',
        }}>
          <span style={{ ...golferPill(true) }}>
            {nameMap.get(f.top_tier_1_golfer_id) ?? f.top_tier_1_golfer_id}
          </span>
          <span style={{ ...golferPill(true) }}>
            {nameMap.get(f.top_tier_2_golfer_id) ?? f.top_tier_2_golfer_id}
          </span>
          <span style={{ ...golferPill(false) }}>
            {nameMap.get(f.dark_horse_1_golfer_id) ?? f.dark_horse_1_golfer_id}
          </span>
          <span style={{ ...golferPill(false) }}>
            {nameMap.get(f.dark_horse_2_golfer_id) ?? f.dark_horse_2_golfer_id}
          </span>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px', fontSize: '13px', color: '#444' }}>
          <span>Proj: <strong>{projected}</strong> vs par</span>
          <span>Conf: <strong>{confidence}%</strong></span>
          <span style={{ color: riskBadgeColor(f.risk_level), fontWeight: 600 }}>
            {f.risk_level.toUpperCase()}
          </span>
          {ownership && <span>Ownership: <strong>{ownership}</strong></span>}
        </div>

        {f.foursome_explanation && (
          <p style={{ margin: '12px 0 0', fontSize: '13px', color: '#555' }}>
            {f.foursome_explanation}
          </p>
        )}

        {(f.key_strengths && f.key_strengths.length > 0) && (
          <p style={{ margin: '8px 0 0', fontSize: '13px', color: '#3a8e5b' }}>
            ✓ {f.key_strengths.join(' · ')}
          </p>
        )}
        {(f.key_concerns && f.key_concerns.length > 0) && (
          <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#c66' }}>
            ⚠ {f.key_concerns.join(' · ')}
          </p>
        )}
      </div>
    </div>
  );
}

const golferPill = (topTier: boolean): React.CSSProperties => ({
  padding: '6px 12px',
  borderRadius: '14px',
  fontSize: '13px',
  fontWeight: 600,
  backgroundColor: topTier ? '#1a3a2e' : '#e5e8eb',
  color: topTier ? '#fff' : '#222',
});

const warningBox: React.CSSProperties = {
  backgroundColor: '#fff8e1',
  border: '1px solid #f0c060',
  padding: '16px',
  borderRadius: '8px',
  margin: '16px 0',
};

const infoBox: React.CSSProperties = {
  backgroundColor: '#eef2f7',
  border: '1px solid #c4d0db',
  padding: '12px 16px',
  borderRadius: '8px',
  margin: '16px 0',
  fontSize: '14px',
};

const primaryButton: React.CSSProperties = {
  display: 'inline-block',
  padding: '8px 16px',
  backgroundColor: '#1a3a2e',
  color: '#fff',
  borderRadius: '4px',
  textDecoration: 'none',
  fontSize: '14px',
  fontWeight: 600,
};
