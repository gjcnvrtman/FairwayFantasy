// /predictions/backtest — list past backtest runs + form to launch a new one.

import Link from 'next/link';
import { db } from '@/lib/db';
import LaunchBacktestForm from './LaunchBacktestForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Backtest — Predictions' };

interface RunRow {
  id: string;
  status: 'pending' | 'running' | 'complete' | 'failed';
  events_tested: number | null;
  events_with_complete_data: number | null;
  avg_projected_vs_actual: string | null;
  avg_best_foursome_rank: string | null;
  pct_beat_league_average: string | null;
  pct_beat_league_winner: string | null;
  avg_sleeper_accuracy: string | null;
  started_at: string;
  completed_at: string | null;
}

interface ScoredTournamentRow {
  id: string;
  name: string;
  start_date: string;
  scores_count: number;
}

async function loadRuns(): Promise<RunRow[]> {
  return await db.selectFrom('backtest_runs')
    .select([
      'id', 'status', 'events_tested', 'events_with_complete_data',
      'avg_projected_vs_actual', 'avg_best_foursome_rank',
      'pct_beat_league_average', 'pct_beat_league_winner',
      'avg_sleeper_accuracy', 'started_at', 'completed_at',
    ])
    .orderBy('started_at', 'desc')
    .limit(50)
    .execute();
}

async function loadScoredTournaments(): Promise<ScoredTournamentRow[]> {
  // Tournaments that have scores rows AND have a course profile linked
  // — those are the eligible backtest targets.
  return await db.selectFrom('tournaments')
    .innerJoin('scores', 'scores.tournament_id', 'tournaments.id')
    .select([
      'tournaments.id as id',
      'tournaments.name as name',
      'tournaments.start_date as start_date',
      eb => eb.fn.count<number>('scores.id').as('scores_count'),
    ])
    .where('tournaments.status', 'in', ['complete', 'cut_made'])
    .where('tournaments.course_profile_id', 'is not', null)
    .groupBy(['tournaments.id', 'tournaments.name', 'tournaments.start_date'])
    .orderBy('tournaments.start_date', 'desc')
    .execute();
}

function fmt(v: string | null, suffix = ''): string {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(2) + suffix;
}

export default async function BacktestListPage() {
  const [runs, eligible] = await Promise.all([loadRuns(), loadScoredTournaments()]);
  return (
    <div style={{ maxWidth: '1100px' }}>
      <h1 style={{ marginTop: 0 }}>Backtests</h1>
      <p style={{ color: '#666' }}>
        Replay the model against past tournaments using only data that
        would have been available the night before. Eligible events are
        complete + have a course profile curated.
      </p>

      <LaunchBacktestForm eligible={eligible} />

      <h2 style={{ marginTop: '32px' }}>Past runs</h2>
      {runs.length === 0 ? (
        <p style={{ color: '#888' }}>No backtest runs yet.</p>
      ) : (
        <table style={tableStyle}>
          <thead style={{ backgroundColor: '#f4f4f1' }}>
            <tr>
              <th style={thStyle}>Started</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Events</th>
              <th style={thStyle}>Δ proj vs actual</th>
              <th style={thStyle}>Avg rank</th>
              <th style={thStyle}>Beat avg %</th>
              <th style={thStyle}>Beat winner %</th>
              <th style={thStyle}>Sleeper acc.</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {runs.map(r => (
              <tr key={r.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={tdStyle}>{new Date(r.started_at).toLocaleString()}</td>
                <td style={tdStyle}>
                  <span style={statusBadge(r.status)}>{r.status}</span>
                </td>
                <td style={tdStyle}>
                  {r.events_tested ?? '—'}
                  {r.events_with_complete_data != null && r.events_tested != null && (
                    <span style={{ color: '#888', fontSize: '12px' }}>
                      {' '}({r.events_with_complete_data} w/ league)
                    </span>
                  )}
                </td>
                <td style={tdStyle}>{fmt(r.avg_projected_vs_actual)}</td>
                <td style={tdStyle}>{fmt(r.avg_best_foursome_rank)}</td>
                <td style={tdStyle}>{fmt(r.pct_beat_league_average, '%')}</td>
                <td style={tdStyle}>{fmt(r.pct_beat_league_winner, '%')}</td>
                <td style={tdStyle}>{fmt(r.avg_sleeper_accuracy)}</td>
                <td style={tdStyle}>
                  <Link href={`/predictions/backtest/${r.id}`}>view</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const tableStyle: React.CSSProperties = {
  width: '100%',
  marginTop: '12px',
  borderCollapse: 'collapse',
  backgroundColor: '#fff',
  border: '1px solid #ddd',
  borderRadius: '8px',
  overflow: 'hidden',
};
const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '12px',
  fontSize: '13px',
  fontWeight: 600,
  color: '#555',
};
const tdStyle: React.CSSProperties = { padding: '12px', fontSize: '14px' };

function statusBadge(status: string): React.CSSProperties {
  const map: Record<string, string> = {
    pending: '#888',
    running: '#3a6ea5',
    complete: '#3a8e5b',
    failed: '#c33',
  };
  return {
    display: 'inline-block',
    padding: '3px 10px',
    borderRadius: '10px',
    backgroundColor: map[status] ?? '#888',
    color: '#fff',
    fontSize: '12px',
    fontWeight: 600,
  };
}
