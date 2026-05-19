'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import InviteCard from '@/components/league/InviteCard';

interface League {
  id:                  string;
  slug:                string;
  name:                string;
  invite_code:         string;
  max_players:         number;
  start_date:          string | null;
  end_date:            string | null;
  weekly_bet_amount:   string;       // pg NUMERIC → string
  created_at:          string;
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
  /** Tournament IDs where this league has submitted at least one
   *  complete pick. Drives the "Tournament Status" filter — show
   *  only past events the league actually participated in. */
  tournamentIdsWithPicks: string[];
  inviteUrl:        string; // built server-side (no window.location use here)
}

export default function AdminPanel({
  league, members, tournaments, activeTournament,
  tournamentIdsWithPicks, inviteUrl,
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

  // ── Tournament window + weekly bet ────────────────────────
  // ISO timestamps from the DB need to be sliced to yyyy-mm-dd for
  // <input type="date">. Empty string when the column is null.
  //
  // Defensive coercion 2026-05-19: pg-node returns TIMESTAMPTZ as JS
  // Date objects, not ISO strings — but the `League` type below
  // declares these fields as `string | null`. The type is a lie at
  // the boundary; legacy leagues with NULL dates short-circuited via
  // the `?` check, so the bug only fired once a real start_date /
  // end_date was set. Normalising here (and in the input handlers
  // that build outbound POST bodies) decouples the rendering from
  // whatever the loader actually returns.
  const toISODateInput = (v: string | Date | null): string => {
    if (!v) return '';
    if (typeof v === 'string') return v.slice(0, 10);
    // Date object → yyyy-mm-dd via ISO conversion
    try { return v.toISOString().slice(0, 10); } catch { return ''; }
  };
  const [startDateInput, setStartDateInput] = useState<string>(
    toISODateInput(league.start_date as unknown as string | Date | null),
  );
  const [endDateInput, setEndDateInput] = useState<string>(
    toISODateInput(league.end_date as unknown as string | Date | null),
  );
  const [windowBusy, setWindowBusy] = useState(false);
  const [windowMsg,  setWindowMsg]  = useState('');
  const [windowErr,  setWindowErr]  = useState('');

  const [betInput,  setBetInput]  = useState<string>(
    Number(league.weekly_bet_amount).toFixed(2),
  );
  const [betBusy,   setBetBusy]   = useState(false);
  const [betMsg,    setBetMsg]    = useState('');
  const [betErr,    setBetErr]    = useState('');

  // ── Pick Deadlines section ───────────────────────────────────
  // Collapsible header — defaults to COLLAPSED. Pick-deadline
  // overrides are an occasional commissioner action, not the main
  // reason they come here; default-collapsed keeps the page short
  // and surfaces other sections (member list, tournament status,
  // settings) above the fold.
  const [deadlinesOpen, setDeadlinesOpen] = useState(false);

  // ── Delete league (Danger Zone) ────────────────────────────────
  // Destructive enough that we gate behind two affordances: (1) the
  // section collapses by default; expand reveals (2) the "type the
  // league name to confirm" input. The Delete button stays disabled
  // until the typed name matches exactly. Server-side re-verifies the
  // same match so a stale tab / hand-crafted curl can't slip past.
  const [dangerOpen,  setDangerOpen]  = useState(false);
  const [deleteInput, setDeleteInput] = useState('');
  const [deleteBusy,  setDeleteBusy]  = useState(false);
  const [deleteErr,   setDeleteErr]   = useState('');

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

  async function saveTournamentWindow() {
    setWindowBusy(true);
    setWindowMsg('');
    setWindowErr('');
    if (!startDateInput || !endDateInput) {
      setWindowErr('Both start and end dates are required.');
      setWindowBusy(false);
      return;
    }
    try {
      const res = await fetch('/api/admin/league-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: league.slug,
          startDate: startDateInput,
          endDate:   endDateInput,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setWindowErr(data.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      setWindowMsg('Saved — tournament window updated.');
      router.refresh();
    } catch (err) {
      setWindowErr(err instanceof Error ? err.message : String(err));
    } finally {
      setWindowBusy(false);
    }
  }

  async function saveBetAmount() {
    setBetBusy(true);
    setBetMsg('');
    setBetErr('');
    const parsed = parseFloat(betInput);
    if (!Number.isFinite(parsed)) {
      setBetErr('Enter a valid dollar amount.');
      setBetBusy(false);
      return;
    }
    try {
      const res = await fetch('/api/admin/league-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: league.slug,
          weeklyBetAmount: parsed,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBetErr(data.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      setBetMsg(`Saved — weekly bet is now $${parsed.toFixed(2)}.`);
      router.refresh();
    } catch (err) {
      setBetErr(err instanceof Error ? err.message : String(err));
    } finally {
      setBetBusy(false);
    }
  }

  async function deleteLeague() {
    setDeleteBusy(true);
    setDeleteErr('');
    try {
      const res = await fetch('/api/admin/league-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug:        league.slug,
          confirmName: deleteInput,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDeleteErr(data.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      // League is gone — anything that tries to render against its
      // slug now will 404, so push back to dashboard rather than
      // calling router.refresh().
      router.push('/dashboard');
    } catch (err) {
      setDeleteErr(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleteBusy(false);
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

          <dt style={{ color: 'var(--slate-mid)' }}>Tournament window</dt>
          <dd style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
            <input
              type="date"
              value={startDateInput}
              onChange={(e) => setStartDateInput(e.target.value)}
              disabled={windowBusy}
              aria-label="Start date"
              style={{ padding: '0.25rem 0.4rem', fontSize: '0.88rem' }}
            />
            <span style={{ color: 'var(--slate-mid)' }}>→</span>
            <input
              type="date"
              value={endDateInput}
              min={startDateInput || undefined}
              onChange={(e) => setEndDateInput(e.target.value)}
              disabled={windowBusy}
              aria-label="End date"
              style={{ padding: '0.25rem 0.4rem', fontSize: '0.88rem' }}
            />
            <button
              type="button"
              onClick={saveTournamentWindow}
              disabled={
                windowBusy ||
                !startDateInput || !endDateInput ||
                // No-op detection: same start AND same end as the
                // currently-stored value. toISODateInput handles
                // pg-node Date objects the same way the initial
                // state setter does (see comment above the helper).
                (startDateInput === toISODateInput(league.start_date as unknown as string | Date | null) &&
                 endDateInput   === toISODateInput(league.end_date   as unknown as string | Date | null))
              }
              aria-busy={windowBusy}
              style={{ padding: '0.25rem 0.75rem', fontSize: '0.85rem' }}
            >
              {windowBusy ? 'Saving…' : 'Save'}
            </button>
          </dd>
          {(windowMsg || windowErr) && (
            <>
              <dt />
              <dd style={{
                color: windowErr ? 'var(--red)' : 'var(--green)',
                fontSize: '0.82rem',
              }}>
                {windowErr || windowMsg}
              </dd>
            </>
          )}

          <dt style={{ color: 'var(--slate-mid)' }}>Weekly bet</dt>
          <dd style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--slate-mid)' }}>$</span>
            <input
              type="number"
              min={0}
              max={1000}
              step={0.01}
              inputMode="decimal"
              value={betInput}
              onChange={(e) => setBetInput(e.target.value)}
              disabled={betBusy}
              aria-label="Weekly bet amount in dollars"
              style={{
                width: '6rem', padding: '0.25rem 0.4rem',
                fontFamily: 'monospace', fontSize: '0.88rem',
              }}
            />
            <button
              type="button"
              onClick={saveBetAmount}
              disabled={
                betBusy ||
                betInput.trim() === '' ||
                parseFloat(betInput) === Number(league.weekly_bet_amount)
              }
              aria-busy={betBusy}
              style={{ padding: '0.25rem 0.75rem', fontSize: '0.85rem' }}
            >
              {betBusy ? 'Saving…' : 'Save'}
            </button>
            <span style={{ color: 'var(--slate-mid)', fontSize: '0.78rem' }}>
              per completed tournament
            </span>
          </dd>
          {(betMsg || betErr) && (
            <>
              <dt />
              <dd style={{
                color: betErr ? 'var(--red)' : 'var(--green)',
                fontSize: '0.82rem',
              }}>
                {betErr || betMsg}
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
      <section className="card" aria-labelledby="deadlines-h" style={{ padding: 0, overflow: 'hidden' }}>
        <button
          type="button"
          onClick={() => setDeadlinesOpen(o => !o)}
          aria-expanded={deadlinesOpen}
          aria-controls="deadlines-body"
          style={{
            display: 'flex',
            width: '100%',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '1.25rem 1.5rem',
            background: 'transparent',
            border: 'none',
            borderBottom: deadlinesOpen ? '1px solid var(--cream-dark)' : 'none',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <h2
            id="deadlines-h"
            style={{
              fontFamily: "'Playfair Display', serif",
              fontSize: '1.2rem',
              fontWeight: 700,
              margin: 0,
            }}
          >
            Pick Deadlines
          </h2>
          <span
            aria-hidden="true"
            style={{ fontSize: '1.2rem', color: 'var(--slate-mid)' }}
          >
            {deadlinesOpen ? '−' : '+'}
          </span>
        </button>

        {deadlinesOpen && (
        <div id="deadlines-body" style={{ padding: '1.25rem 1.5rem' }}>
        <p style={{ color: 'var(--slate-mid)', fontSize: '0.85rem', marginBottom: '1rem', marginTop: 0 }}>
          The auto-computed deadline (start date − 1h) is often wrong vs the real first
          tee time. Override per tournament here — empty input + Save clears the override.
          Affects all leagues.
        </p>

        {(() => {
          // Future-only filter: tournaments with status='upcoming' AND
          // start_date in the future (≥ today − 1 day grace). The grace
          // window keeps a tournament visible briefly after it starts in
          // case a last-minute deadline change is needed. The ESPN
          // status-never-flips-to-complete bug (P0 TODO) means many past
          // tournaments still carry status='upcoming' — without the
          // start_date floor they'd dominate the list and bury the
          // actual next event.
          const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
          const upcoming = tournaments
            .filter(t => t.status === 'upcoming')
            .filter(t => {
              if (!t.start_date) return true;  // unknown date — keep, don't hide
              return new Date(t.start_date) >= dayAgo;
            })
            // Sort ascending by start_date — next tournament first,
            // then chronological after that.
            .sort((a, b) => {
              const aDate = a.start_date ? new Date(a.start_date).getTime() : Number.MAX_SAFE_INTEGER;
              const bDate = b.start_date ? new Date(b.start_date).getTime() : Number.MAX_SAFE_INTEGER;
              return aDate - bDate;
            });
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
        </div>
        )}
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
        {(() => {
          // Filter to PRIOR tournaments this league actually
          // participated in (had complete picks for). Greg's call
          // 2026-05-19: the firehose-of-every-PGA-event view was noise;
          // the useful view is "events where bets were on the line."
          // "Prior" = status='complete' OR start_date is >7 days ago.
          // The 7-day buffer handles the open P0 TODO where ESPN
          // doesn't flip status to 'complete' after the event ends —
          // a tournament that started 8+ days ago has finished, even
          // if the row still says 'upcoming'.
          const pickedSet = new Set(tournamentIdsWithPicks);
          const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
          const priorWithBets = tournaments
            .filter(t => pickedSet.has(t.id))
            .filter(t => {
              if (t.status === 'complete') return true;
              if (!t.start_date) return false;
              return new Date(t.start_date).getTime() < cutoffMs;
            })
            // Most recent first — typical use is "what just happened?"
            .sort((a, b) => {
              const aDate = a.start_date ? new Date(a.start_date).getTime() : 0;
              const bDate = b.start_date ? new Date(b.start_date).getTime() : 0;
              return bDate - aDate;
            });

          if (priorWithBets.length === 0) {
            return (
              <p style={{ padding: '2rem', color: 'var(--slate-mid)', textAlign: 'center', fontSize: '0.9rem' }}>
                No completed tournaments where this league has placed bets yet.
              </p>
            );
          }
          return (
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
              {priorWithBets.map(t => (
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
          );
        })()}
      </section>

      {/* ── Danger Zone ────────────────────────────────────────
           Permanently destructive. Two affordances gate the delete:
           collapsed-by-default header, then a "type the league name"
           confirm input. Server-side re-verifies the name match. */}
      <section
        className="card"
        style={{
          padding: 0,
          overflow: 'hidden',
          border: '1px solid var(--red-soft, #f4d4d4)',
        }}
        aria-labelledby="danger-h"
      >
        <button
          type="button"
          onClick={() => setDangerOpen(o => !o)}
          style={{
            display: 'flex',
            width: '100%',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '1.25rem 1.5rem',
            background: 'transparent',
            border: 'none',
            borderBottom: dangerOpen ? '1px solid var(--cream-dark)' : 'none',
            cursor: 'pointer',
            textAlign: 'left',
          }}
          aria-expanded={dangerOpen}
        >
          <h2
            id="danger-h"
            style={{
              fontFamily: "'Playfair Display', serif",
              fontSize: '1.2rem',
              fontWeight: 700,
              color: 'var(--red, #b04545)',
              margin: 0,
            }}
          >
            ⚠ Danger Zone
          </h2>
          <span
            aria-hidden="true"
            style={{ fontSize: '1.2rem', color: 'var(--slate-mid)' }}
          >
            {dangerOpen ? '−' : '+'}
          </span>
        </button>

        {dangerOpen && (
          <div style={{ padding: '1.25rem 1.5rem' }}>
            <p style={{ marginTop: 0, fontSize: '0.9rem', color: 'var(--slate-mid)' }}>
              Deleting this league removes <strong>every</strong> member, pick,
              fantasy result, season standing, and reminder log row. <strong>This
              cannot be undone.</strong> If a tournament is currently in progress
              the delete will be refused — wait until it completes.
            </p>
            <p style={{ fontSize: '0.85rem', color: 'var(--slate-mid)', marginBottom: '0.75rem' }}>
              To confirm, type the league&rsquo;s exact name:{' '}
              <strong>{league.name}</strong>
            </p>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                type="text"
                value={deleteInput}
                onChange={e => setDeleteInput(e.target.value)}
                placeholder="Type league name to enable Delete"
                disabled={deleteBusy}
                aria-label="Confirm league name to delete"
                style={{
                  flex: '1 1 240px',
                  minWidth: 0,
                  padding: '0.55rem 0.7rem',
                  fontSize: '0.95rem',
                  border: '1px solid var(--cream-dark)',
                  borderRadius: '4px',
                }}
              />
              <button
                type="button"
                onClick={deleteLeague}
                disabled={deleteBusy || deleteInput !== league.name}
                className="btn"
                style={{
                  background: 'var(--red, #b04545)',
                  color: 'white',
                  border: 'none',
                  padding: '0.55rem 1rem',
                  fontSize: '0.9rem',
                  fontWeight: 600,
                  borderRadius: '4px',
                  cursor: deleteBusy || deleteInput !== league.name ? 'not-allowed' : 'pointer',
                  opacity: deleteBusy || deleteInput !== league.name ? 0.5 : 1,
                }}
              >
                {deleteBusy ? 'Deleting…' : `Delete "${league.name}" permanently`}
              </button>
            </div>
            {deleteErr && (
              <p
                className="hint"
                style={{ color: 'var(--red)', marginTop: '0.6rem', fontSize: '0.85rem' }}
              >
                {deleteErr}
              </p>
            )}
          </div>
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
