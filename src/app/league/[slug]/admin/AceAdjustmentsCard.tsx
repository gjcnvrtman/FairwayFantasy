'use client';

// Commissioner corrections for the hole-in-one bounty (migration 027).
// Lists the aces that currently count, lets the admin remove one (or
// restore a removed one), and add an ace the ESPN data missed.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface AceRow {
  tournamentId: string; tournamentName: string;
  golferId: string; golferName: string;
  round: number; hole: number;
  source: 'auto' | 'manual';
}
export interface VoidedAceRow {
  tournamentId: string; tournamentName: string;
  golferId: string; golferName: string;
  round: number; hole: number;
}
export interface AceCandidates {
  tournamentId: string; tournamentName: string;
  golfers: Array<{ id: string; name: string }>;
}

export default function AceAdjustmentsCard({ slug, aces, voided, candidates }: {
  slug:       string;
  aces:       AceRow[];
  voided:     VoidedAceRow[];
  candidates: AceCandidates[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState('');
  const [tId, setTId]   = useState(candidates[0]?.tournamentId ?? '');
  const [gId, setGId]   = useState('');
  const [round, setRound] = useState('1');
  const [hole, setHole]   = useState('');

  async function call(method: 'POST' | 'DELETE', body: object) {
    setBusy(true); setErr('');
    try {
      const res = await fetch('/api/admin/aces', {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, ...body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(data.error ?? `Failed (HTTP ${res.status})`); return false; }
      router.refresh();
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const key = (a: { tournamentId: string; golferId: string; round: number; hole: number }) =>
    ({ tournamentId: a.tournamentId, golferId: a.golferId, round: a.round, hole: a.hole });
  const golfers = candidates.find(c => c.tournamentId === tId)?.golfers ?? [];

  return (
    <section className="card" aria-labelledby="aces-h">
      <h2 id="aces-h" style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.4rem' }}>
        Hole-in-ones
      </h2>
      <p style={{ color: 'var(--slate-mid)', fontSize: '0.85rem', marginBottom: '0.9rem' }}>
        Aces are detected automatically from the hole-by-hole data. If ESPN missed one or recorded one
        wrongly, fix it here — the bounty recalculates everywhere.
      </p>

      {aces.length === 0 ? (
        <p style={{ fontSize: '0.85rem', color: 'var(--slate-mid)' }}>No aces counted yet.</p>
      ) : (
        <table className="lb-table" style={{ fontSize: '0.85rem', marginBottom: '1rem' }}>
          <thead><tr><th>Golfer</th><th>Tournament</th><th>R · Hole</th><th>Remove</th></tr></thead>
          <tbody>
            {aces.map(a => (
              <tr key={`${a.tournamentId}:${a.golferId}:${a.round}:${a.hole}`}>
                <td>{a.golferName}{a.source === 'manual' && <span className="badge badge-gray" style={{ marginLeft: 6 }}>added</span>}</td>
                <td>{a.tournamentName}</td>
                <td>R{a.round} · #{a.hole}</td>
                <td>
                  <button type="button" className="btn btn-sm btn-ghost" disabled={busy}
                          onClick={() => a.source === 'manual'
                            ? call('DELETE', key(a))
                            : call('POST', { ...key(a), action: 'void' })}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {voided.length > 0 && (
        <div style={{ marginBottom: '1rem', fontSize: '0.85rem' }}>
          <p style={{ fontWeight: 700, margin: '0 0 0.3rem' }}>Removed</p>
          {voided.map(v => (
            <div key={`${v.tournamentId}:${v.golferId}:${v.round}:${v.hole}`}
                 style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <span style={{ textDecoration: 'line-through', color: 'var(--slate-mid)' }}>
                {v.golferName} · {v.tournamentName} · R{v.round} #{v.hole}
              </span>
              <button type="button" className="btn btn-sm btn-ghost" disabled={busy}
                      onClick={() => call('DELETE', key(v))}>Restore</button>
            </div>
          ))}
        </div>
      )}

      {candidates.length > 0 && (
        <div style={{ background: 'var(--cream)', padding: '0.8rem', borderRadius: 'var(--radius-sm)' }}>
          <p style={{ fontWeight: 700, fontSize: '0.85rem', margin: '0 0 0.5rem' }}>Add an ace the data missed</p>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={tId} onChange={e => { setTId(e.target.value); setGId(''); }}
                    aria-label="Tournament" style={{ padding: '0.3rem', fontSize: '0.85rem' }}>
              {candidates.map(c => <option key={c.tournamentId} value={c.tournamentId}>{c.tournamentName}</option>)}
            </select>
            <select value={gId} onChange={e => setGId(e.target.value)}
                    aria-label="Golfer" style={{ padding: '0.3rem', fontSize: '0.85rem' }}>
              <option value="">Golfer…</option>
              {golfers.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <select value={round} onChange={e => setRound(e.target.value)}
                    aria-label="Round" style={{ padding: '0.3rem', fontSize: '0.85rem' }}>
              {[1, 2, 3, 4].map(r => <option key={r} value={r}>R{r}</option>)}
            </select>
            <input type="number" min={1} max={18} placeholder="Hole" value={hole}
                   onChange={e => setHole(e.target.value)} aria-label="Hole"
                   style={{ width: '5rem', padding: '0.3rem', fontSize: '0.85rem' }} />
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !gId || !hole}
                    onClick={async () => {
                      const ok = await call('POST', {
                        tournamentId: tId, golferId: gId, round: Number(round), hole: Number(hole), action: 'add',
                      });
                      if (ok) { setGId(''); setHole(''); }
                    }}>
              Add ace
            </button>
          </div>
          <p className="hint" style={{ margin: '0.4rem 0 0' }}>Only golfers on a team in this league are listed.</p>
        </div>
      )}

      {err && <p style={{ color: 'var(--red)', fontSize: '0.85rem', marginTop: '0.6rem' }}>{err}</p>}
    </section>
  );
}
