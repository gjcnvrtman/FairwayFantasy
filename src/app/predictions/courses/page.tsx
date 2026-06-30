// ============================================================
// /predictions/courses — list all course profiles + entry to create.
// Admin-gated by the layout.
// ============================================================

import Link from 'next/link';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Course Profiles' };

interface ProfileRow {
  id: string;
  name: string;
  total_par: number | null;
  total_yardage: number | null;
  scoring_difficulty: string | null;
  updated_at: string;
  linked_tournament_name: string | null;
}

async function loadProfiles(): Promise<ProfileRow[]> {
  return await db.selectFrom('course_profiles')
    .leftJoin('tournaments', 'tournaments.course_profile_id', 'course_profiles.id')
    .select([
      'course_profiles.id as id',
      'course_profiles.name as name',
      'course_profiles.total_par as total_par',
      'course_profiles.total_yardage as total_yardage',
      'course_profiles.scoring_difficulty as scoring_difficulty',
      'course_profiles.updated_at as updated_at',
      'tournaments.name as linked_tournament_name',
    ])
    .orderBy('course_profiles.updated_at', 'desc')
    .execute();
}

export default async function CourseProfilesPage() {
  const rows = await loadProfiles();
  return (
    <div style={{ maxWidth: '1100px' }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        marginBottom: '8px',
      }}>
        <h1 style={{ margin: 0 }}>Course profiles</h1>
        <Link
          href="/predictions/courses/new"
          style={{
            padding: '8px 16px',
            backgroundColor: '#1a3a2e',
            color: '#fff',
            borderRadius: '4px',
            textDecoration: 'none',
            fontSize: '14px',
            fontWeight: 600,
          }}
        >
          + New profile
        </Link>
      </div>
      <p style={{ color: '#666', marginTop: 0 }}>
        Hand-curated course-fit fields per tournament. The predictor
        needs at least one of these on each tournament before it can run.
      </p>

      {rows.length === 0 ? (
        <p style={{ color: '#888', marginTop: '32px' }}>
          No course profiles yet. Click <strong>+ New profile</strong> to
          add one — pick the tournament it&apos;s for and fill in as much
          as you know.
        </p>
      ) : (
        <table style={{
          width: '100%',
          marginTop: '16px',
          borderCollapse: 'collapse',
          backgroundColor: '#fff',
          border: '1px solid #ddd',
          borderRadius: '8px',
          overflow: 'hidden',
        }}>
          <thead style={{ backgroundColor: '#f4f4f1' }}>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Tournament</th>
              <th style={thStyle}>Par</th>
              <th style={thStyle}>Yardage</th>
              <th style={thStyle}>Scoring diff.</th>
              <th style={thStyle}>Updated</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={tdStyle}>{r.name}</td>
                <td style={tdStyle}>
                  {r.linked_tournament_name ?? (
                    <span style={{ color: '#aaa' }}>unlinked</span>
                  )}
                </td>
                <td style={tdStyle}>{r.total_par ?? '—'}</td>
                <td style={tdStyle}>{r.total_yardage ?? '—'}</td>
                <td style={tdStyle}>{r.scoring_difficulty ?? '—'}</td>
                <td style={tdStyle}>
                  {new Date(r.updated_at).toLocaleDateString()}
                </td>
                <td style={tdStyle}>
                  <Link href={`/predictions/courses/${r.id}`}>edit</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '12px',
  fontSize: '13px',
  fontWeight: 600,
  color: '#555',
};

const tdStyle: React.CSSProperties = {
  padding: '12px',
  fontSize: '14px',
};
