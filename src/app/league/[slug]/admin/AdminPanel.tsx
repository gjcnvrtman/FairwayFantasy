'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import InviteCard from '@/components/league/InviteCard';

interface League {
  id:           string;
  slug:         string;
  name:         string;
  invite_code:  string;
  max_players:  number;
  created_at:   string;
}

interface Member {
  user_id:   string;
  role:      'commissioner' | 'member';
  joined_at: string;
  // The query helper returns the full profile row OR null when the
  // join misses. We only read two fields here, but accepting the full
  // shape keeps the prop type compatible with what kysely emits.
  profile?:  { display_name?: string; email?: string } | null;
}

interface Tournament {
  id:                      string;
  name:                    string;
  type:                    'regular' | 'major';
  start_date:              string;
  status:                  'upcoming' | 'active' | 'cut_made' | 'complete';
  cut_score:               number | null;
  pick_deadline:           string | null;
  pick_deadline_override:  string | null;
}

interface Props {
  league:           League;
  members:          Member[];
  tournaments:      Tournament[];
  activeTournament: Tournament | null;
  inviteUrl:        string; // built server-side (no window.location use here)
}

export default function AdminPanel({
  league, members, tournaments, activeTournament, inviteUrl,
}: Props) {
  const router = useRouter();

  const [syncing,    setSyncing]    = useState(false);
  const [syncMsg,    setSyncMsg]    = useState('');
  const [syncOk,     setSyncOk]     = useState<boolean | null>(null);
  const [removing,   setRemoving]   = useState<string | null>(null);
  const [removeErr,  setRemoveErr]  = useState('');
  const [newInvite,  setNewInvite]  = useState('');
  const [regenErr,   setRegenErr]   = useState('');
  const [regenWorking, setRegenWorking] = useState(false);

  // ── League settings (max_players) ────────────────────────
  const [maxPlayersInput, setMaxPlayersInput] = useState<string>(
    String(league.max_players),
  );
  const [maxPlayersBusy, setMaxPlayersBusy]   = useState(false);
  const [maxPlayersMsg,  setMaxPlayersMsg]    = useState('');
  const [maxPlayersErr,  setMaxPlayersErr]    = useState('');

  // Effective invite path (current code, or freshly regenerated one)
  const effectiveCode = newInvite || league.invite_code;
  const effectiveUrl  = newInvite
    ? inviteUrl.replace(league.invite_code, newInvite)
    : inviteUrl;
  const effectivePath = `/join/${league.slug}/${effectiveCode}`;

  // ── Action handlers ────────────────────────────────────────

  async function triggerSync() {
    setSyncing(true); setSyncMsg(''); setSyncOk(null);
    try {
      const res = await fetch('/api/admin/sync-scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leagueId: league.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSyncMsg(data.error ?? `Failed (HTTP ${res.status})`);
        setSyncOk(false);
        return;
      }
      const summary = data.touched
        ? `Synced ${data.touched} tournament${data.touched === 1 ? '' : 's'}`
        : (data.message ?? 'No active tournaments to sync');
      setSyncMsg(summary);
      setSyncOk(true);
      router.refresh();
    } catch (err) {
      setSyncMsg(err instanceof Error ? err.message : String(err));
      setSyncOk(false);
    } finally {
      setSyncing(false);
    }
  }

  async function removeMember(userId: string, displayName: string) {
    setRemoveErr('');
    if (!confirm(`Remove ${displayName} from the league? They'll lose access to picks and standings.`)) {
      return;
    }
    setRemoving(userId);
    try {
      const res = await fetch(
        `/api/leagues/members?leagueId=${encodeURIComponent(league.id)}&userId=${encodeURIComponent(userId)}`,
        { method: 'DELETE' },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRemoveErr(data.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      router.refresh();
    } catch (err) {
      setRemoveErr(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoving(null);
    }
  }

  async function regenerateInvite() {
    setRegenErr('');
    if (!confirm('Regenerate the invite code? The current link will stop working immediately.')) {
      return;
    }
    setRegenWorking(true);
    try {
      const res = await fetch('/api/leagues/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leagueId: league.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRegenErr(data.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      if (data.inviteCode) setNewInvite(data.inviteCode);
    } catch (err) {
      setRegenErr(err instanceof Error ? err.message : String(err));
    } finally {
      setRegenWorking(false);
    }
  }

  async function saveMaxPlayers() {
    setMaxPlayersBusy(true);
    setMaxPlayersMsg('');
    setMaxPlayersErr('');
    const parsed = Number(maxPlayersInput);
    if (!Number.isInteger(parsed)) {
      setMaxPlayersErr('Enter a whole number.');
      setMaxPlayersBusy(false);
      return;
    }
    try {
      const res = await fetch('/api/admin/league-settings', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ slug: league.slug, maxPlayers: parsed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMaxPlayersErr(data.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      setMaxPlayersMsg(`Saved — max players is now ${data.league?.max_players ?? parsed}.`);
      router.refresh();
    } catch (err) {
      setMaxPlayersErr(err instanceof Error ? err.message : String(err));
    } finally {
      setMaxPlayersBusy(false);
    }
  }

  // ── Pick-deadline override handlers ───────────────────────
  // Keyed by tournament id so multiple rows can edit independently.
  const [deadlineInputs,  setDeadlineInputs]  = useState<Record<string, string>>({});
  const [deadlineBusy,    setDeadlineBusy]    = useState<string | null>(null);
  const [deadlineMsg,     setDeadlineMsg]     = useState<Record<string, string>>({});
  const [deadlineErr,     setDeadlineErr]     = useState<Record<string, string>>({});

  async function savePickDeadline(tournamentId: string, deadlineIso: string | null) {
    setDeadlineBusy(tournamentId);
    setDeadlineMsg(prev => ({ ...prev, [tournamentId]: '' }));
    setDeadlineErr(prev => ({ ...prev, [tournamentId]: '' }));
    try {
      const res = await fetch('/api/admin/pick-deadline', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          slug:         league.slug,
          tournamentId,
          deadline:     deadlineIso,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDeadlineErr(prev => ({ ...prev, [tournamentId]: data.error ?? `Failed (HTTP ${res.status})` }));
        return;
      }
      setDeadlineMsg(prev => ({
        ...prev,
        [tournamentId]: deadlineIso
          ? `Override set → ${new Date(deadlineIso).toLocaleString()}`
          : 'Override cleared — using default deadline',
      }));
      router.refresh();
    } catch (err) {
      setDeadlineErr(prev => ({
        ...prev,
        [tournamentId]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setDeadlineBusy(null);
    }
  }

  // ── Render ─────────────────────────────────────────────────

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '1.5rem',
      maxWidth: 920, margin: '0 auto',
    }}>

      {/* ── League settings — read-only summary ─────────────── */}
      <section className="card" aria-labelledby="settings-h">
        <h2 id="settings-h" style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.6rem',
        }}>
          League Settings
        </h2>
        <p style={{ color: 'var(--slate-mid)', fontSize: '0.85rem', marginBottom: '1rem' }}>
          Name and URL slug are fixed at creation. Max players can grow or
          shrink — shrinking below the current member count requires
          removing members first.
        </p>
        <dl style={{
          display: 'grid', gridTemplateColumns: 'minmax(120px, max-content) 1fr',
          gap: '0.5rem 1rem', fontSize: '0.9rem',
        }}>
          <dt style={{ color: 'var(--slate-mid)' }}>Name</dt>
          <dd style={{ fontWeight: 600 }}>{league.name}</dd>

          <dt style={{ color: 'var(--slate-mid)' }}>URL slug</dt>
          <dd style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>
            /league/{league.slug}
          </dd>

          <dt style={{ color: 'var(--slate-mid)' }}>Max players</dt>
          <dd style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <input
              type="number"
              min={4}
              max={50}
              step={1}
              value={maxPlayersInput}
              onChange={(e) => setMaxPlayersInput(e.target.value)}
              disabled={maxPlayersBusy}
              aria-label="Max players"
              style={{
                width: '5rem',
                padding: '0.25rem 0.4rem',
                fontFamily: 'monospace',
                fontSize: '0.9rem',
              }}
            />
            <button
              type="button"
              onClick={saveMaxPlayers}
              disabled={
                maxPlayersBusy ||
                maxPlayersInput.trim() === '' ||
                Number(maxPlayersInput) === league.max_players
              }
              aria-busy={maxPlayersBusy}
              style={{ padding: '0.25rem 0.75rem', fontSize: '0.85rem' }}
            >
              {maxPlayersBusy ? 'Saving…' : 'Save'}
            </button>
            <span style={{ color: 'var(--slate-mid)', fontSize: '0.78rem' }}>
              currently {members.length} member{members.length === 1 ? '' : 's'}
            </span>
            {members.length >= league.max_players && (
              <span style={{ color: 'var(--red)', fontSize: '0.78rem' }}>
                · league is full
              </span>
            )}
          </dd>

          {(maxPlayersMsg || maxPlayersErr) && (
            <>
              <dt />
              <dd style={{
                color: maxPlayersErr ? 'var(--red)' : 'var(--green)',
                fontSize: '0.82rem',
              }}>
                {maxPlayersErr || maxPlayersMsg}
              </dd>
            </>
          )}

          <dt style={{ color: 'var(--slate-mid)' }}>Created</dt>
          <dd>{new Date(league.created_at).toLocaleDateString('en-US', {
            year: 'numeric', month: 'long', day: 'numeric',
          })}</dd>
        </dl>
      </section>

      {/* ── Score sync ─────────────────────────────────────── */}
      <section className="card" aria-labelledby="sync-h">
        <h2 id="sync-h" style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.4rem',
        }}>
          Score Sync
        </h2>
        <p style={{ color: 'var(--slate-mid)', fontSize: '0.875rem', marginBottom: '1rem' }}>
          Scores sync automatically every 10 min during tournaments via the systemd timer.
          Trigger manually here if a sync got missed.
        </p>
        {activeTournament ? (
          <>
            <div className="alert alert-info" style={{ marginBottom: '1rem' }}>
              <div><strong>{activeTournament.name}</strong></div>
              <div style={{ fontSize: '0.85rem', marginTop: '0.2rem' }}>
                Status: <strong>{activeTournament.status}</strong>
                {activeTournament.cut_score !== null && (
                  <> · Cut: <strong>
                    {activeTournament.cut_score > 0 ? '+' : ''}{activeTournament.cut_score}
                  </strong></>
                )}
              </div>
            </div>
            <button
              className="btn btn-primary"
              onClick={triggerSync}
              disabled={syncing}
              aria-busy={syncing}
            >
              {syncing ? '⏳ Syncing…' : '🔄 Sync Scores Now'}
            </button>
          </>
        ) : (
          <p style={{ color: 'var(--slate-mid)', fontSize: '0.875rem' }}>
            No active tournament right now.
          </p>
        )}
        {syncMsg && (
          <p style={{
            marginTop: '0.75rem', fontSize: '0.85rem',
            color: syncOk === false ? 'var(--red)' : 'var(--green-mid)',
          }} role="status">
            {syncOk === false ? '❌ ' : '✅ '}{syncMsg}
          </p>
        )}
      </section>

      {/* ── Invite link — uses shared <InviteCard> client component
          so copy-to-clipboard fallback is consistent across the app
          (and works on http LAN). Bug #4.9 fix. */}
      <section aria-labelledby="invite-h">
        <h2 id="invite-h" style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.6rem',
        }}>
          Invite Link
        </h2>
        <InviteCard
          inviteUrl={effectiveUrl}
          invitePath={effectivePath}
          slug={league.slug}
          title="Share to invite players"
          subhead="Anyone who clicks this link can join the league. Regenerate to invalidate it."
        />
        <div style={{
          marginTop: '0.75rem',
          display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center',
        }}>
          <button
            className="btn btn-outline btn-sm"
            onClick={regenerateInvite}
            disabled={regenWorking}
            aria-busy={regenWorking}
          >
            {regenWorking ? '⏳ Regenerating…' : '🔄 Regenerate Code'}
          </button>
          {newInvite && (
            <span style={{ color: 'var(--green-mid)', fontSize: '0.85rem' }}>
              ✓ New code generated. Old link is now invalid.
            </span>
          )}
          {regenErr && (
            <span style={{ color: 'var(--red)', fontSize: '0.85rem' }} role="alert">
              {regenErr}
            </span>
          )}
        </div>
      </section>

      {/* ── Members ────────────────────────────────────────── */}
      <section className="card" style={{ padding: 0, overflow: 'hidden' }} aria-labelledby="members-h">
        <div style={{
          padding: '1.25rem 1.5rem',
          borderBottom: '1px solid var(--cream-dark)',
        }}>
          <h2 id="members-h" style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: '1.2rem', fontWeight: 700,
          }}>
            League Members ({members.length})
          </h2>
        </div>
        {removeErr && (
          <div className="alert alert-error" style={{ margin: '0.75rem 1.5rem 0' }} role="alert">
            {removeErr}
          </div>
        )}
        <table className="lb-table">
          <thead>
            <tr>
              <th>Player</th>
              <th className="hide-mobile">Email</th>
              <th>Role</th>
              <th className="hide-mobile">Joined</th>
              <th aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody>
            {members.map(m => (
              <tr key={m.user_id}>
                <td>
                  <strong>{m.profile?.display_name ?? 'Unnamed Player'}</strong>
                  {/* On mobile, fold the email under the name since the column is hidden */}
                  {m.profile?.email && (
                    <div className="show-mobile" style={{ fontSize: '0.72rem', color: 'var(--slate-mid)', marginTop: '0.1rem' }}>
                      {m.profile.email}
                    </div>
                  )}
                </td>
                <td className="hide-mobile" style={{ color: 'var(--slate-mid)', fontSize: '0.85rem' }}>
                  {m.profile?.email ?? '—'}
                </td>
                <td>
                  <span className={`badge ${m.role === 'commissioner' ? 'badge-brass' : 'badge-gray'}`}>
                    {m.role === 'commissioner' ? '★ Commissioner' : 'Member'}
                  </span>
                </td>
                <td className="hide-mobile" style={{ color: 'var(--slate-mid)', fontSize: '0.82rem' }}>
                  {new Date(m.joined_at).toLocaleDateString('en-US', {
                    month: 'short', day: 'numeric', year: 'numeric',
                  })}
                </td>
                <td>
                  {m.role !== 'commissioner' && (
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ color: 'var(--red)' }}
                      onClick={() => removeMember(m.user_id, m.profile?.display_name ?? 'this player')}
                      disabled={removing === m.user_id}
                      aria-busy={removing === m.user_id}
                    >
                      {removing === m.user_id ? '…' : 'Remove'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* ── Pick-deadline overrides ─────────────────────────── */}
      <section className="card" aria-labelledby="deadlines-h">
        <h2 id="deadlines-h" style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.4rem',
        }}>
          Pick Deadlines
        </h2>
        <p style={{ color: 'var(--slate-mid)', fontSize: '0.85rem', marginBottom: '1rem' }}>
          The auto-computed deadline (start date − 1h) is often wrong vs the real first
          tee time. Override per tournament here — empty input + Save clears the override.
          Affects all leagues.
        </p>

        {(() => {
          const upcoming = tournaments.filter(t => t.status === 'upcoming');
          if (upcoming.length === 0) {
            return (
              <p style={{ color: 'var(--slate-mid)', fontSize: '0.85rem', fontStyle: 'italic' }}>
                No upcoming tournaments — nothing to override.
              </p>
            );
          }
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {upcoming.map(t => {
                // Render the value as a local datetime-input string. The
                // `<input type="datetime-local">` element wants
                // 'YYYY-MM-DDTHH:MM' in the browser's local time.
                const currentOverride = t.pick_deadline_override
                  ? new Date(t.pick_deadline_override)
                  : null;
                const currentDefault = t.pick_deadline
                  ? new Date(t.pick_deadline)
                  : null;
                const effective = currentOverride ?? currentDefault;
                const inputVal  = deadlineInputs[t.id] ?? (currentOverride
                  ? toLocalInputValue(currentOverride)
                  : '');
                const busy      = deadlineBusy === t.id;
                const msg       = deadlineMsg[t.id];
                const err       = deadlineErr[t.id];

                return (
                  <div key={t.id} style={{
                    padding: '0.75rem 0.85rem',
                    border: '1px solid var(--cream-dark)',
                    borderRadius: 'var(--radius-sm)',
                  }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: '0.5rem',
                      flexWrap: 'wrap', marginBottom: '0.5rem',
                    }}>
                      <strong style={{ fontSize: '0.9rem', flex: '1 1 200px', minWidth: 0 }}>
                        {t.name}
                      </strong>
                      <span style={{ fontSize: '0.72rem', color: 'var(--slate-mid)' }}>
                        Starts {new Date(t.start_date).toLocaleString('en-US', {
                          weekday: 'short', month: 'short', day: 'numeric',
                          hour: 'numeric', minute: '2-digit',
                        })}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--slate-mid)', marginBottom: '0.5rem' }}>
                      Effective deadline:{' '}
                      <strong style={{ color: 'var(--slate)' }}>
                        {effective ? effective.toLocaleString() : 'none'}
                      </strong>
                      {currentOverride
                        ? <span style={{ color: 'var(--brass)', marginLeft: '0.4rem' }}>(override)</span>
                        : <span style={{ color: 'var(--slate-light)', marginLeft: '0.4rem' }}>(default)</span>}
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                      <input
                        type="datetime-local"
                        className="input"
                        value={inputVal}
                        onChange={e => setDeadlineInputs(prev => ({ ...prev, [t.id]: e.target.value }))}
                        style={{ flex: '1 1 220px', minWidth: 0 }}
                        disabled={busy}
                      />
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy}
                        aria-busy={busy}
                        onClick={() => {
                          const iso = inputVal ? new Date(inputVal).toISOString() : null;
                          savePickDeadline(t.id, iso);
                        }}
                      >
                        {busy ? 'Saving…' : 'Save'}
                      </button>
                      {currentOverride && (
                        <button
                          type="button"
                          className="btn btn-outline btn-sm"
                          disabled={busy}
                          onClick={() => {
                            setDeadlineInputs(prev => ({ ...prev, [t.id]: '' }));
                            savePickDeadline(t.id, null);
                          }}
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    {err && <p className="hint" style={{ color: 'var(--red)', marginTop: '0.4rem' }}>{err}</p>}
                    {msg && <p className="hint" style={{ color: 'var(--green-mid)', marginTop: '0.4rem' }}>{msg}</p>}
                  </div>
                );
              })}
            </div>
          );
        })()}
      </section>

      {/* ── Tournament status ──────────────────────────────── */}
      <section className="card" style={{ padding: 0, overflow: 'hidden' }} aria-labelledby="tourn-h">
        <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--cream-dark)' }}>
          <h2 id="tourn-h" style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: '1.2rem', fontWeight: 700,
          }}>
            Tournament Status
          </h2>
        </div>
        {tournaments.length === 0 ? (
          <p style={{ padding: '2rem', color: 'var(--slate-mid)', textAlign: 'center', fontSize: '0.9rem' }}>
            No tournaments populated yet. Check the schedule sync.
          </p>
        ) : (
          <table className="lb-table">
            <thead>
              <tr>
                <th>Tournament</th>
                <th className="hide-mobile">Type</th>
                <th>Starts</th>
                <th>Status</th>
                <th className="hide-mobile">Cut</th>
              </tr>
            </thead>
            <tbody>
              {tournaments.map(t => (
                <tr key={t.id}>
                  <td><strong style={{ fontSize: '0.875rem' }}>{t.name}</strong></td>
                  <td className="hide-mobile">
                    <span className={`badge ${t.type === 'major' ? 'badge-brass' : 'badge-gray'}`}>
                      {t.type === 'major' ? '🏆 Major' : 'Regular'}
                    </span>
                  </td>
                  <td style={{ fontSize: '0.82rem', color: 'var(--slate-mid)' }}>
                    {new Date(t.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </td>
                  <td>
                    <span className={`badge ${
                      t.status === 'active'   ? 'badge-live'
                      : t.status === 'complete' ? 'badge-green'
                      : t.status === 'cut_made' ? 'badge-blue'
                      : 'badge-gray'
                    }`}>
                      {t.status}
                    </span>
                  </td>
                  <td className="hide-mobile" style={{ fontSize: '0.85rem' }}>
                    {t.cut_score !== null
                      ? `${t.cut_score > 0 ? '+' : ''}${t.cut_score}`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// `<input type="datetime-local">` wants 'YYYY-MM-DDTHH:MM' in the
// browser's local time zone. Date.toISOString() gives UTC, which
// renders correctly on its own but is shifted in the input. Build
// the local-time string by hand.
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' +
    pad(d.getMonth() + 1) + '-' +
    pad(d.getDate()) + 'T' +
    pad(d.getHours()) + ':' +
    pad(d.getMinutes())
  );
}
