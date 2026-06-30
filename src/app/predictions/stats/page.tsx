// /predictions/stats — upload golfer stat snapshots + browse past uploads.

import { db } from '@/lib/db';
import { sql } from 'kysely';
import UploadStatsForm from './UploadStatsForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Stats — Predictions' };

interface SnapshotGroup {
  as_of_date: string;
  total: number;
  matched: number;
  unmatched: number;
  last_uploaded_at: string;
}

async function loadGroups(): Promise<SnapshotGroup[]> {
  const result = await sql<{
    as_of_date: string;
    total: string;
    matched: string;
    unmatched: string;
    last_uploaded_at: string;
  }>`
    SELECT
      as_of_date::text AS as_of_date,
      COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE golfer_id IS NOT NULL)::text AS matched,
      COUNT(*) FILTER (WHERE golfer_id IS NULL)::text AS unmatched,
      MAX(uploaded_at)::text AS last_uploaded_at
    FROM golfer_stat_snapshots
    GROUP BY as_of_date
    ORDER BY as_of_date DESC
    LIMIT 50
  `.execute(db);
  return result.rows.map(r => ({
    as_of_date: r.as_of_date,
    total: Number(r.total),
    matched: Number(r.matched),
    unmatched: Number(r.unmatched),
    last_uploaded_at: r.last_uploaded_at,
  }));
}

export default async function StatsPage() {
  const groups = await loadGroups();
  return (
    <div style={{ maxWidth: '900px' }}>
      <h1 style={{ marginTop: 0 }}>Stats snapshots</h1>
      <p style={{ color: '#666' }}>
        Upload golfer stat CSVs assembled from PGA Tour stats pages.
        The predictor reads the latest snapshot at-or-before each
        tournament&apos;s pick_deadline. Column spec + workflow lives
        in <a href="https://github.com/gjcnvrtman/FairwayFantasy/blob/main/STATS-IMPORT.md"
              target="_blank" rel="noreferrer">STATS-IMPORT.md</a>.
      </p>

      <UploadStatsForm />

      <h2 style={{ marginTop: '32px' }}>Past uploads</h2>
      {groups.length === 0 ? (
        <p style={{ color: '#888' }}>No snapshots uploaded yet.</p>
      ) : (
        <table style={tableStyle}>
          <thead style={{ backgroundColor: '#f4f4f1' }}>
            <tr>
              <th style={thStyle}>As-of date</th>
              <th style={thStyle}>Total rows</th>
              <th style={thStyle}>Matched</th>
              <th style={thStyle}>Unmatched</th>
              <th style={thStyle}>Last uploaded</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(g => (
              <tr key={g.as_of_date} style={{ borderTop: '1px solid #eee' }}>
                <td style={tdStyle}><strong>{g.as_of_date}</strong></td>
                <td style={tdStyle}>{g.total}</td>
                <td style={tdStyle}>{g.matched}</td>
                <td style={tdStyle}>
                  {g.unmatched > 0
                    ? <span style={{ color: '#c66' }}>{g.unmatched}</span>
                    : g.unmatched}
                </td>
                <td style={tdStyle}>{new Date(g.last_uploaded_at).toLocaleString()}</td>
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
  marginTop: '16px',
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
