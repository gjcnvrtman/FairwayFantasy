'use client';

// Form to launch a backtest run. Multi-select of eligible tournaments
// (those with scores + a curated course profile). POSTs to
// /api/predictions/backtests, navigates to the new run's detail page
// on success.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface EligibleTournament {
  id: string;
  name: string;
  start_date: string;
  scores_count: number;
}

interface Props { eligible: EligibleTournament[] }

export default function LaunchBacktestForm({ eligible }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(eligible.map(t => t.id)));
  }
  function clear() {
    setSelected(new Set());
  }

  async function submit() {
    if (selected.size === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/predictions/backtests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tournament_ids: Array.from(selected) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) {
        setError(body?.error ?? `HTTP ${res.status}`);
        setSubmitting(false);
        return;
      }
      const runId = body.backtestRunId;
      router.push(`/predictions/backtest/${runId}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong style={{ fontSize: '15px' }}>Launch new backtest</strong>
        <span style={{ color: '#666', fontSize: '13px' }}>
          {eligible.length} eligible event(s)
        </span>
      </div>

      {eligible.length === 0 ? (
        <p style={{ color: '#888', marginTop: '12px' }}>
          No eligible tournaments. Backtest needs events that are complete
          AND have a course profile linked — curate at least one profile
          for a past event under <strong>Course Profiles</strong> first.
        </p>
      ) : (
        <>
          <div style={{
            margin: '12px 0',
            maxHeight: '240px',
            overflowY: 'auto',
            border: '1px solid #eee',
            borderRadius: '4px',
            padding: '8px 12px',
          }}>
            {eligible.map(t => (
              <label key={t.id} style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '6px 0',
                cursor: 'pointer',
                fontSize: '14px',
              }}>
                <input
                  type="checkbox"
                  checked={selected.has(t.id)}
                  onChange={() => toggle(t.id)}
                />
                <span style={{ flex: 1 }}>{t.name}</span>
                <span style={{ color: '#888', fontSize: '12px' }}>
                  {new Date(t.start_date).toLocaleDateString()}
                </span>
              </label>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <button
              type="button"
              onClick={submit}
              disabled={submitting || selected.size === 0}
              style={{
                padding: '10px 20px',
                backgroundColor: (submitting || selected.size === 0) ? '#888' : '#1a3a2e',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                cursor: (submitting || selected.size === 0) ? 'not-allowed' : 'pointer',
                fontSize: '14px',
                fontWeight: 600,
              }}
            >
              {submitting ? 'Running...' : `Run backtest (${selected.size} event(s))`}
            </button>
            <button type="button" onClick={selectAll} style={secondaryButton}>Select all</button>
            <button type="button" onClick={clear} style={secondaryButton}>Clear</button>
            {error && <span style={{ color: '#c33', fontSize: '13px' }}>{error}</span>}
          </div>

          <p style={{ marginTop: '12px', fontSize: '12px', color: '#888' }}>
            Each event runs the full predictor with as-of date = pick_deadline − 1 day.
            ~5–15 seconds per event; large runs may take a minute or more.
          </p>
        </>
      )}
    </div>
  );
}

const secondaryButton: React.CSSProperties = {
  padding: '8px 12px',
  backgroundColor: '#fff',
  border: '1px solid #ccc',
  borderRadius: '4px',
  cursor: 'pointer',
  fontSize: '13px',
};
