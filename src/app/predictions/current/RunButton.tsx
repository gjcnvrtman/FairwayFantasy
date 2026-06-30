'use client';

// Client-side trigger for POST /api/predictions/runs. Renders an
// inline state machine: idle → running → success/error → idle.
// On success we refresh the server-rendered page so the latest run
// row + foursomes load.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function RunButton({ tournamentId }: { tournamentId: string }) {
  const router = useRouter();
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  async function run() {
    setState({ kind: 'running' });
    try {
      const res = await fetch('/api/predictions/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tournament_id: tournamentId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) {
        const msg = body?.error ?? `HTTP ${res.status}`;
        setState({ kind: 'error', message: msg });
        return;
      }
      // Success — server-refresh to pull the new run + foursomes.
      router.refresh();
      setState({ kind: 'idle' });
    } catch (e) {
      setState({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
      <button
        type="button"
        onClick={run}
        disabled={state.kind === 'running'}
        style={{
          padding: '8px 16px',
          backgroundColor: state.kind === 'running' ? '#888' : '#1a3a2e',
          color: '#fff',
          border: 'none',
          borderRadius: '4px',
          cursor: state.kind === 'running' ? 'wait' : 'pointer',
          fontSize: '14px',
          fontWeight: 600,
        }}
      >
        {state.kind === 'running' ? 'Running...' : 'Run predictions'}
      </button>
      {state.kind === 'error' && (
        <span style={{ color: '#c33', fontSize: '13px' }}>
          {state.message}
        </span>
      )}
    </div>
  );
}
