'use client';

// League rules + setup lifecycle (migration 025). Rendered only for
// leagues created with the new setup flow — legacy leagues keep the
// original League Settings editors in AdminPanel.
//
//   setup  → rules editable, "Import ESPN calendar" + "Lock league
//            setup" actions, banner showing when auto-lock happens.
//   locked → the same rules, read-only.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface SetupRules {
  slug:                    string;
  start_date:              string | Date | null;
  end_date:                string | Date | null;
  weekly_bet_amount:       string;
  major_bet_amount:        string | null;
  payout_pct_1:            number;
  payout_pct_2:            number;
  payout_pct_3:            number;
  missed_cut_penalty:      number;
  missed_deadline_penalty: number;
  major_team_size:         number;   // 4 or 6 (migration 026)
  setup_locked_at:         string | Date | null;
}

function toDateInput(v: string | Date | null): string {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  try { return v.toISOString().slice(0, 10); } catch { return ''; }
}

function fmtDate(v: string | Date): string {
  return new Date(v).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago', timeZoneName: 'short',
  });
}

const money = (v: string | number) => `$${Number(v).toFixed(2)}`;

export default function LeagueSetupCard({ league, status, autoLock, isCommissioner, scheduleCount }: {
  league:         SetupRules;
  status:         'setup' | 'locked';
  autoLock:       { tournamentName: string; at: string } | null;
  isCommissioner: boolean;
  scheduleCount:  number;
}) {
  const router = useRouter();
  const editable = status === 'setup' && isCommissioner;

  const [startDate, setStartDate] = useState(toDateInput(league.start_date));
  const [endDate,   setEndDate]   = useState(toDateInput(league.end_date));
  const [weekly,    setWeekly]    = useState(Number(league.weekly_bet_amount).toFixed(2));
  const [major,     setMajor]     = useState(league.major_bet_amount == null ? '' : Number(league.major_bet_amount).toFixed(2));
  const [pcts,      setPcts]      = useState([
    String(league.payout_pct_1), String(league.payout_pct_2), String(league.payout_pct_3),
  ]);
  const [mcPen, setMcPen] = useState(String(league.missed_cut_penalty));
  const [mdPen, setMdPen] = useState(String(league.missed_deadline_penalty));
  const [teamSize, setTeamSize] = useState<number>(league.major_team_size === 6 ? 6 : 4);

  const [busy, setBusy] = useState<'' | 'save' | 'lock' | 'import'>('');
  const [msg,  setMsg]  = useState('');
  const [err,  setErr]  = useState('');

  const pctNums = pcts.map(p => parseInt(p, 10));
  const pctSum  = pctNums.every(Number.isInteger) ? pctNums.reduce((s, p) => s + p, 0) : NaN;

  async function post(url: string, body: object) {
    const res  = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: league.slug, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Failed (HTTP ${res.status})`);
    return data;
  }

  async function save() {
    setBusy('save'); setMsg(''); setErr('');
    try {
      await post('/api/admin/league-settings', {
        startDate, endDate,
        weeklyBetAmount: parseFloat(weekly),
        majorBetAmount:  major.trim() === '' ? null : parseFloat(major),
        payoutPct1: pctNums[0], payoutPct2: pctNums[1], payoutPct3: pctNums[2],
        missedCutPenalty:      parseInt(mcPen, 10),
        missedDeadlinePenalty: parseInt(mdPen, 10),
        majorTeamSize:         teamSize,
      });
      setMsg('Saved.');
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  async function importCalendar() {
    setBusy('import'); setMsg(''); setErr('');
    try {
      const data = await post('/api/admin/schedule-import', {});
      setMsg(data.added > 0
        ? `Added ${data.added} event(s) from ESPN — review the Schedule below.`
        : 'No new events in your date window. ESPN may not have published them yet.');
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  async function lock() {
    if (!window.confirm(
      'Lock league setup? Bets, payout split, penalties, date window and schedule '
      + 'can never be changed after this.',
    )) return;
    setBusy('lock'); setMsg(''); setErr('');
    try {
      await post('/api/admin/league-lock', {});
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  const input = (w: string) => ({
    width: w, padding: '0.25rem 0.4rem', fontFamily: 'monospace', fontSize: '0.88rem',
  });

  return (
    <section className="card" aria-labelledby="rules-h"
             style={{ borderLeft: `4px solid ${status === 'setup' ? 'var(--brass)' : 'var(--green-mid)'}` }}>
      <h2 id="rules-h" style={{
        fontFamily: "'Playfair Display', serif", fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.4rem',
      }}>
        League Rules {status === 'locked' ? '🔒' : ''}
      </h2>

      {status === 'setup' ? (
        <div className="alert alert-warn" style={{ marginBottom: '1rem', fontSize: '0.85rem' }}>
          <strong>Setup mode.</strong> Review the rules and prune the Schedule below, then lock
          the league. Nothing here can change after it locks.
          {autoLock && (
            <> It locks automatically at <strong>{fmtDate(autoLock.at)}</strong> when picks lock
            for {autoLock.tournamentName}.</>
          )}
          {!autoLock && scheduleCount === 0 && (
            <> Your schedule is empty — import the ESPN calendar once it&rsquo;s published.</>
          )}
        </div>
      ) : (
        <p style={{ color: 'var(--slate-mid)', fontSize: '0.85rem', marginBottom: '1rem' }}>
          Locked{league.setup_locked_at ? ` ${fmtDate(league.setup_locked_at)}` : ''}. These rules are final.
        </p>
      )}

      <dl style={{
        display: 'grid', gridTemplateColumns: 'minmax(140px, max-content) 1fr',
        gap: '0.6rem 1rem', fontSize: '0.9rem', alignItems: 'center',
      }}>
        <dt style={{ color: 'var(--slate-mid)' }}>Tournament window</dt>
        <dd style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
          {editable ? (
            <>
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                     aria-label="Window start" style={input('9.5rem')} />
              <span>→</span>
              <input type="date" value={endDate} min={startDate || undefined}
                     onChange={e => setEndDate(e.target.value)}
                     aria-label="Window end" style={input('9.5rem')} />
            </>
          ) : (
            <span>{startDate || '—'} → {endDate || '—'}</span>
          )}
        </dd>

        <dt style={{ color: 'var(--slate-mid)' }}>Weekly bet</dt>
        <dd>
          {editable ? (
            <input type="number" min={0} max={1000} step={0.01} inputMode="decimal"
                   value={weekly} onChange={e => setWeekly(e.target.value)}
                   aria-label="Weekly bet in dollars" style={input('6rem')} />
          ) : money(league.weekly_bet_amount)}
        </dd>

        <dt style={{ color: 'var(--slate-mid)' }}>Majors bet</dt>
        <dd>
          {editable ? (
            <input type="number" min={0} max={1000} step={0.01} inputMode="decimal"
                   placeholder="Same as weekly"
                   value={major} onChange={e => setMajor(e.target.value)}
                   aria-label="Majors bet in dollars" style={input('8rem')} />
          ) : (league.major_bet_amount == null ? 'Same as weekly' : money(league.major_bet_amount))}
        </dd>

        <dt style={{ color: 'var(--slate-mid)' }}>Majors team size</dt>
        <dd>
          {editable ? (
            <select value={teamSize} onChange={e => setTeamSize(Number(e.target.value))}
                    aria-label="Team size for majors"
                    style={{ padding: '0.25rem 0.4rem', fontSize: '0.88rem' }}>
              <option value={4}>4 golfers — 2 top + 2 dark horse, best 3 count</option>
              <option value={6}>6 golfers — 3 top + 3 dark horse, best 4 count</option>
            </select>
          ) : league.major_team_size === 6
            ? '6 golfers — 3 top + 3 dark horse, best 4 count'
            : '4 golfers (same as regular events)'}
        </dd>

        <dt style={{ color: 'var(--slate-mid)' }}>Payout split</dt>
        <dd style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
          {editable ? (
            <>
              {(['1st', '2nd', '3rd'] as const).map((label, i) => (
                <span key={label} style={{ display: 'inline-flex', gap: '0.25rem', alignItems: 'center' }}>
                  <span style={{ color: 'var(--slate-mid)', fontSize: '0.82rem' }}>{label}</span>
                  <input type="number" min={0} max={100} step={1} inputMode="numeric"
                         value={pcts[i]}
                         onChange={e => setPcts(p => p.map((v, j) => j === i ? e.target.value : v))}
                         aria-label={`${label} place payout percentage`} style={input('3.6rem')} />
                  <span style={{ color: 'var(--slate-mid)' }}>%</span>
                </span>
              ))}
              <span style={{
                fontFamily: 'monospace', fontSize: '0.82rem',
                color: pctSum === 100 ? 'var(--green)' : 'var(--red)',
              }}>
                sum = {Number.isNaN(pctSum) ? '—' : pctSum}
              </span>
            </>
          ) : (
            <span>{league.payout_pct_1}% / {league.payout_pct_2}% / {league.payout_pct_3}%</span>
          )}
        </dd>

        <dt style={{ color: 'var(--slate-mid)' }}>Missed-cut penalty</dt>
        <dd>
          {editable ? (
            <input type="number" min={0} max={10} step={1} inputMode="numeric"
                   value={mcPen} onChange={e => setMcPen(e.target.value)}
                   aria-label="Missed-cut penalty in strokes" style={input('4rem')} />
          ) : league.missed_cut_penalty}
          <span style={{ color: 'var(--slate-mid)', fontSize: '0.82rem' }}> strokes per golfer</span>
        </dd>

        <dt style={{ color: 'var(--slate-mid)' }}>Missed-deadline penalty</dt>
        <dd>
          {editable ? (
            <input type="number" min={0} max={10} step={1} inputMode="numeric"
                   value={mdPen} onChange={e => setMdPen(e.target.value)}
                   aria-label="Missed-deadline penalty in strokes" style={input('4rem')} />
          ) : league.missed_deadline_penalty}
          <span style={{ color: 'var(--slate-mid)', fontSize: '0.82rem' }}> strokes</span>
        </dd>
      </dl>

      {status === 'setup' && isCommissioner && (
        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', marginTop: '1.25rem' }}>
          <button type="button" className="btn btn-primary btn-sm"
                  onClick={save} disabled={busy !== '' || pctSum !== 100} aria-busy={busy === 'save'}>
            {busy === 'save' ? 'Saving…' : 'Save rules'}
          </button>
          <button type="button" className="btn btn-outline btn-sm"
                  onClick={importCalendar} disabled={busy !== ''} aria-busy={busy === 'import'}>
            {busy === 'import' ? 'Importing…' : 'Import ESPN calendar'}
          </button>
          <button type="button" className="btn btn-brass btn-sm"
                  onClick={lock} disabled={busy !== '' || scheduleCount === 0} aria-busy={busy === 'lock'}
                  style={{ marginLeft: 'auto' }}>
            {busy === 'lock' ? 'Locking…' : '🔒 Lock league setup'}
          </button>
        </div>
      )}
      {status === 'setup' && isCommissioner && (
        <p className="hint" style={{ marginTop: '0.5rem' }}>
          Import adds every ESPN event in your date window that isn&rsquo;t on the schedule —
          including any you removed earlier.
        </p>
      )}
      {status === 'setup' && !isCommissioner && (
        <p className="hint" style={{ marginTop: '0.75rem' }}>
          Only the commissioner can change rules or lock setup.
        </p>
      )}

      {(msg || err) && (
        <p style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: err ? 'var(--red)' : 'var(--green-mid)' }}>
          {err || msg}
        </p>
      )}
    </section>
  );
}
