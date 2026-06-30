'use client';

// "Email predictions" button — re-sends the top-5 for the given run
// to all platform admins. Auto-emails fire on field-publish via
// runFieldSync hook; this button is the manual re-send path.

import { useState } from 'react';

export default function EmailButton({ runId }: { runId: string }) {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'sending' }
    | { kind: 'sent'; count: number; failed: number }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  async function send() {
    setState({ kind: 'sending' });
    try {
      const res = await fetch(`/api/predictions/runs/${runId}/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) {
        setState({ kind: 'error', message: body?.error ?? `HTTP ${res.status}` });
        return;
      }
      setState({
        kind: 'sent',
        count: body.sent ?? 0,
        failed: (body.failed ?? []).length,
      });
    } catch (e) {
      setState({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <button
        type="button"
        onClick={send}
        disabled={state.kind === 'sending'}
        style={{
          padding: '8px 14px',
          backgroundColor: '#fff',
          color: '#1a3a2e',
          border: '1px solid #1a3a2e',
          borderRadius: '4px',
          cursor: state.kind === 'sending' ? 'wait' : 'pointer',
          fontSize: '14px',
          fontWeight: 600,
        }}
      >
        {state.kind === 'sending' ? 'Sending...' : '✉ Email predictions'}
      </button>
      {state.kind === 'sent' && (
        <span style={{
          fontSize: '13px',
          color: state.failed > 0 ? '#c66' : '#3a8e5b',
        }}>
          Sent {state.count}{state.failed > 0 && `, ${state.failed} failed`}
        </span>
      )}
      {state.kind === 'error' && (
        <span style={{ color: '#c33', fontSize: '13px' }}>{state.message}</span>
      )}
    </div>
  );
}
