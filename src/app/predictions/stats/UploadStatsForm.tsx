'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface UploadResult {
  ok: boolean;
  asOfDate: string;
  inserted: number;
  upserted: number;
  summary: {
    exact: number;
    fuzzy: number;
    none: number;
    warnings: string[];
  };
  unmatchedNames: string[];
  fuzzyDeferred: { raw: string; suggestion: string; distance: number }[];
}

export default function UploadStatsForm() {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const [asOfDate, setAsOfDate] = useState<string>(today);
  const [file, setFile] = useState<File | null>(null);
  const [autoLinkFuzzy, setAutoLinkFuzzy] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setError(null);
    setResult(null);
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.set('file', file);
      fd.set('as_of_date', asOfDate);
      fd.set('auto_link_fuzzy', autoLinkFuzzy ? 'true' : 'false');
      const res = await fetch('/api/predictions/stats/upload', {
        method: 'POST',
        body: fd,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error ?? `HTTP ${res.status}`);
      } else {
        setResult(body);
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{
      backgroundColor: '#fff',
      border: '1px solid #ddd',
      borderRadius: '8px',
      padding: '20px',
      marginTop: '16px',
    }}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={labelStyle}>CSV file</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={e => setFile(e.target.files?.[0] ?? null)}
            required
            style={{ fontSize: '14px' }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={labelStyle}>As-of date (YYYY-MM-DD)</span>
          <input
            type="date"
            value={asOfDate}
            onChange={e => setAsOfDate(e.target.value)}
            required
            style={inputStyle}
          />
          <span style={{ fontSize: '12px', color: '#888' }}>
            The predictor uses the latest snapshot at-or-before each
            tournament&apos;s pick_deadline. Usually the Wednesday of
            tournament week.
          </span>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <input
            type="checkbox"
            checked={autoLinkFuzzy}
            onChange={e => setAutoLinkFuzzy(e.target.checked)}
          />
          <span style={{ fontSize: '13px' }}>
            Auto-link fuzzy matches (Levenshtein ≤ 2)
          </span>
        </label>

        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginTop: '4px' }}>
          <button
            type="submit"
            disabled={submitting || !file}
            style={{
              padding: '10px 20px',
              backgroundColor: (submitting || !file) ? '#888' : '#1a3a2e',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: (submitting || !file) ? 'not-allowed' : 'pointer',
              fontSize: '14px',
              fontWeight: 600,
            }}
          >
            {submitting ? 'Uploading...' : 'Upload'}
          </button>
          {error && <span style={{ color: '#c33', fontSize: '13px' }}>{error}</span>}
        </div>
      </form>

      {result && (
        <div style={{
          marginTop: '16px',
          padding: '12px',
          backgroundColor: '#eef5ee',
          border: '1px solid #b9d4b9',
          borderRadius: '4px',
          fontSize: '13px',
        }}>
          <strong>Upload complete</strong> ({result.asOfDate})
          <ul style={{ margin: '6px 0 0 18px' }}>
            <li>Inserted: <strong>{result.inserted}</strong></li>
            <li>Upserted (existing snapshot replaced): <strong>{result.upserted}</strong></li>
            <li>Exact matches: <strong>{result.summary.exact}</strong></li>
            <li>Fuzzy matches: <strong>{result.summary.fuzzy}</strong></li>
            <li>Unmatched: <strong>{result.summary.none}</strong></li>
          </ul>
          {result.summary.warnings.length > 0 && (
            <details style={{ marginTop: '8px' }}>
              <summary style={{ cursor: 'pointer' }}>
                {result.summary.warnings.length} parse warning(s)
              </summary>
              <ul style={{ marginTop: '6px', color: '#666' }}>
                {result.summary.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </details>
          )}
          {result.unmatchedNames.length > 0 && (
            <details style={{ marginTop: '8px' }}>
              <summary style={{ cursor: 'pointer' }}>
                Unmatched names ({result.unmatchedNames.length}) — inserted with NULL golfer_id
              </summary>
              <ul style={{ marginTop: '6px', color: '#666' }}>
                {result.unmatchedNames.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </details>
          )}
          {result.fuzzyDeferred.length > 0 && (
            <details style={{ marginTop: '8px' }}>
              <summary style={{ cursor: 'pointer' }}>
                Fuzzy candidates left unlinked ({result.fuzzyDeferred.length})
              </summary>
              <ul style={{ marginTop: '6px', color: '#666' }}>
                {result.fuzzyDeferred.map((f, i) => (
                  <li key={i}>
                    &quot;{f.raw}&quot; → &quot;{f.suggestion}&quot; (distance {f.distance})
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: '13px', color: '#555', fontWeight: 600,
};
const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  border: '1px solid #ccc',
  borderRadius: '4px',
  fontSize: '14px',
  width: '100%',
  boxSizing: 'border-box',
};
