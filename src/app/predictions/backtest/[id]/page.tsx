// /predictions/backtest/[id] — one backtest run's aggregate + per-event
// detail table.

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { db } from '@/lib/db';

interface Props { params: { id: string } }

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Backtest Detail' };

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
  notes: string | null;
  started_at: string;
  completed_at: string | null;
}

interface ResultRow {
  id: string;
  tournament_id: string;
  tournament_name: string;
  start_date: string;
  prediction_run_id: string | null;
  projected_score: string | null;
  actual_score: string | null;
  best_recommended_rank_in_league: number | null;
  beat_league_average: boolean | null;
  beat_league_winner: boolean | null;
  avg_finish_recommended: string | null;
  made_cut_pct: string | null;
  top_10_pct: string | null;
  top_20_pct: string | null;
  regret_score: string | null;
  sleeper_accuracy: string | null;
}

function fmt(v: string | null, suffix = ''): string {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(2) + suffix;
}

export default async function BacktestDetailPage({ params }: Props) {
  const run = await db.selectFrom('backtest_runs')
    .selectAll()
    .where('id', '=', params.id)
    .executeTakeFirst();
  if (!run) notFound();

  const results = await db.selectFrom('backtest_results')
    .innerJoin('tournaments', 'tournaments.id', 'backtest_results.tournament_id')
    .select([
      'backtest_results.id as id',
      'backtest_results.tournament_id as tournament_id',
      'tournaments.name as tournament_name',
      'tournaments.start_date as start_date',
      'backtest_results.prediction_run_id as prediction_run_id',
      'backtest_results.projected_score as projected_score',
      'backtest_results.actual_score as actual_score',
      'backtest_results.best_recommended_rank_in_league as best_recommended_rank_in_league',
      'backtest_results.beat_league_average as beat_league_average',
      'backtest_results.beat_league_winner as beat_league_winner',
      'backtest_results.avg_finish_recommended as avg_finish_recommended',
      'backtest_results.made_cut_pct as made_cut_pct',
      'backtest_results.top_10_pct as top_10_pct',
      'backtest_results.top_20_pct as top_20_pct',
      'backtest_results.regret_score as regret_score',
      'backtest_results.sleeper_accuracy as sleeper_accuracy',
    ])
    .where('backtest_results.backtest_run_id', '=', params.id)
    .orderBy('tournaments.start_date', 'asc')
    .execute();

  const r = run as RunRow;
  return (
    <div style={{ maxWidth: '1200px' }}>
      <Link href="/predictions/backtest" style={{ fontSize: '13px' }}>← all backtests</Link>
      <h1 style={{ marginTop: '8px' }}>Backtest run</h1>
      <p style={{ color: '#666', fontSize: '14px' }}>
        Started {new Date(r.started_at).toLocaleString()}
        {r.completed_at && <> · completed {new Date(r.completed_at).toLocaleString()}</>}
        {' '}· status: <strong>{r.status}</strong>
      </p>
      {r.notes && (
        <p style={{ color: '#c33', fontSize: '14px' }}>Error: {r.notes}</p>
      )}

      {/* Aggregate */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: '12px',
        margin: '20px 0',
      }}>
        <Metric label="Events tested" value={r.events_tested?.toString() ?? '—'} />
        <Metric label="w/ league data" value={r.events_with_complete_data?.toString() ?? '—'} />
        <Metric label="Δ proj vs actual" value={fmt(r.avg_projected_vs_actual)} />
        <Metric label="Avg best rank" value={fmt(r.avg_best_foursome_rank)} />
        <Metric label="Beat avg %" value={fmt(r.pct_beat_league_average, '%')} />
        <Metric label="Beat winner %" value={fmt(r.pct_beat_league_winner, '%')} />
        <Metric label="Sleeper accuracy" value={fmt(r.avg_sleeper_accuracy)} />
      </div>

      {/* Per-event */}
      <h2>Per-event results</h2>
      {results.length === 0 ? (
        <p style={{ color: '#888' }}>No results yet.</p>
      ) : (
        <table style={tableStyle}>
          <thead style={{ backgroundColor: '#f4f4f1' }}>
            <tr>
              <th style={thStyle}>Tournament</th>
              <th style={thStyle}>Proj</th>
              <th style={thStyle}>Actual</th>
              <th style={thStyle}>League rank</th>
              <th style={thStyle}>Beat avg</th>
              <th style={thStyle}>Beat win</th>
              <th style={thStyle}>Avg finish</th>
              <th style={thStyle}>MC %</th>
              <th style={thStyle}>Top 10 %</th>
              <th style={thStyle}>Top 20 %</th>
              <th style={thStyle}>Regret</th>
              <th style={thStyle}>Sleeper</th>
            </tr>
          </thead>
          <tbody>
            {(results as ResultRow[]).map(res => (
              <tr key={res.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={tdStyle}>{res.tournament_name}</td>
                <td style={tdStyle}>{fmt(res.projected_score)}</td>
                <td style={tdStyle}>{fmt(res.actual_score)}</td>
                <td style={tdStyle}>{res.best_recommended_rank_in_league ?? '—'}</td>
                <td style={tdStyle}>{boolBadge(res.beat_league_average)}</td>
                <td style={tdStyle}>{boolBadge(res.beat_league_winner)}</td>
                <td style={tdStyle}>{fmt(res.avg_finish_recommended)}</td>
                <td style={tdStyle}>{fmt(res.made_cut_pct, '%')}</td>
                <td style={tdStyle}>{fmt(res.top_10_pct, '%')}</td>
                <td style={tdStyle}>{fmt(res.top_20_pct, '%')}</td>
                <td style={tdStyle}>{fmt(res.regret_score)}</td>
                <td style={tdStyle}>{fmt(res.sleeper_accuracy)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      backgroundColor: '#fff',
      border: '1px solid #ddd',
      borderRadius: '8px',
      padding: '12px',
    }}>
      <div style={{ fontSize: '12px', color: '#666', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: '20px', fontWeight: 700, marginTop: '4px' }}>{value}</div>
    </div>
  );
}

function boolBadge(b: boolean | null): React.ReactNode {
  if (b == null) return <span style={{ color: '#888' }}>—</span>;
  return (
    <span style={{
      color: b ? '#3a8e5b' : '#c33',
      fontWeight: 600,
    }}>{b ? '✓' : '✗'}</span>
  );
}

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  backgroundColor: '#fff',
  border: '1px solid #ddd',
  borderRadius: '8px',
  overflow: 'hidden',
};
const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 8px',
  fontSize: '12px',
  fontWeight: 600,
  color: '#555',
};
const tdStyle: React.CSSProperties = { padding: '10px 8px', fontSize: '13px' };
