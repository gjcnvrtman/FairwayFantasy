'use client';

// ─────────────────────────────────────────────────────────────
// SMACK BOARD — per-tournament chat thread. Renders as a
// floating panel anchored bottom-right with a launcher FAB,
// close button, and per-tournament open/closed state persisted
// in localStorage. On viewports < 640px the panel expands to
// fill the screen so it isn't squashed against thumbs.
//
// Each row:
//   • author display_name + relative time
//   • body
//   • optional ✕ delete button (own message OR commissioner/co)
//
// Compose box at the bottom: textarea (auto-grow to 4 rows),
// Enter to send, Shift+Enter for newline, Send button.
//
// Polls every 20s while open AND tab is visible. The launcher
// also polls (slower, 60s) so the unread badge stays current
// without the panel being open.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Match the panel's mobile breakpoint. Kept in sync with the inline
// style overrides below so both branch on the same threshold.
const MOBILE_MAX_PX = 640;

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_MAX_PX}px)`);
    const apply = () => setMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return mobile;
}

interface MessageView {
  id:           string;
  user_id:      string;
  display_name: string;
  body:         string;
  created_at:   string;
  canDelete:    boolean;
}

interface Props {
  slug:           string;
  tournamentId:   string;
  tournamentName: string;
  currentUserId:  string;
}

const POLL_MS_OPEN   = 20_000;
const POLL_MS_CLOSED = 60_000;
const BODY_MAX       = 500;

function openKey(slug: string, tournamentId: string)     { return `smackboard:open:${slug}:${tournamentId}`; }
function lastSeenKey(slug: string, tournamentId: string) { return `smackboard:lastSeen:${slug}:${tournamentId}`; }

export default function SmackBoard({ slug, tournamentId, tournamentName, currentUserId }: Props) {
  const isMobile = useIsMobile();
  const [messages,  setMessages]  = useState<MessageView[]>([]);
  const [loaded,    setLoaded]    = useState(false);
  const [loadError, setLoadError] = useState('');

  const [draft,    setDraft]   = useState('');
  const [sending,  setSending] = useState(false);
  const [sendErr,  setSendErr] = useState('');

  // open / lastSeen — hydrated from localStorage on mount. SSR-safe:
  // start closed, then snap to the persisted value in the effect so
  // the server-rendered HTML matches the first client paint.
  const [open,     setOpen]     = useState(false);
  const [lastSeen, setLastSeen] = useState<number>(0);

  // The "tick" state forces a re-render every minute so relative
  // timestamps ("3m ago") stay fresh without re-polling.
  const [, setTick] = useState(0);

  const visibleRef = useRef(true);

  // ── localStorage hydration ───────────────────────────────────
  useEffect(() => {
    try {
      const o = window.localStorage.getItem(openKey(slug, tournamentId));
      if (o === '1') setOpen(true);
      const ls = window.localStorage.getItem(lastSeenKey(slug, tournamentId));
      if (ls) setLastSeen(Number(ls) || 0);
    } catch { /* private-mode / SSR — ignore */ }
  }, [slug, tournamentId]);

  // Persist open state.
  useEffect(() => {
    try { window.localStorage.setItem(openKey(slug, tournamentId), open ? '1' : '0'); }
    catch { /* ignore */ }
  }, [open, slug, tournamentId]);

  // ── data fetch ───────────────────────────────────────────────
  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(
        `/api/leagues/${encodeURIComponent(slug)}/messages?tournamentId=${encodeURIComponent(tournamentId)}`,
        { signal, credentials: 'same-origin' },
      );
      if (!res.ok) {
        setLoadError(`Failed to load (HTTP ${res.status})`);
        return;
      }
      const data = await res.json();
      if (Array.isArray(data.messages)) {
        setMessages(data.messages as MessageView[]);
        setLoadError('');
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, [slug, tournamentId]);

  // Initial load + poll loop. Cadence depends on whether the panel
  // is open (fast) or closed (slow — just keeps unread count fresh).
  useEffect(() => {
    const ctrl = new AbortController();
    reload(ctrl.signal);

    const interval = open ? POLL_MS_OPEN : POLL_MS_CLOSED;
    const id = window.setInterval(() => {
      if (!visibleRef.current) return;
      reload();
    }, interval);

    const onVis = () => { visibleRef.current = document.visibilityState === 'visible'; };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      ctrl.abort();
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [reload, open]);

  // Tick the relative-time clock every 60s while open.
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setTick(t => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, [open]);

  // When the panel opens, mark "now" as seen so the badge clears.
  useEffect(() => {
    if (!open) return;
    const now = Date.now();
    setLastSeen(now);
    try { window.localStorage.setItem(lastSeenKey(slug, tournamentId), String(now)); }
    catch { /* ignore */ }
  }, [open, slug, tournamentId]);

  // Unread = messages newer than lastSeen, excluding your own. Until
  // hydration completes lastSeen is 0, which would mark every message
  // unread on first paint; gate the badge on `loaded` so the count
  // only appears once we actually know what to compare against.
  const unread = useMemo(() => {
    if (!loaded) return 0;
    return messages.filter(m => {
      if (m.user_id === currentUserId) return false;
      const t = Date.parse(m.created_at);
      return Number.isFinite(t) && t > lastSeen;
    }).length;
  }, [messages, lastSeen, currentUserId, loaded]);

  // ── send / delete ────────────────────────────────────────────
  async function send() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true); setSendErr('');
    try {
      const res = await fetch(`/api/leagues/${encodeURIComponent(slug)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ tournamentId, body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSendErr(data.fieldErrors?.body ?? data.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      if (data.message) {
        setMessages(prev => [data.message as MessageView, ...prev]);
      }
      setDraft('');
    } catch (err) {
      setSendErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  async function deleteMessage(id: string) {
    if (!confirm('Delete this message?')) return;
    try {
      const res = await fetch(
        `/api/leagues/${encodeURIComponent(slug)}/messages/${encodeURIComponent(id)}`,
        { method: 'DELETE', credentials: 'same-origin' },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      setMessages(prev => prev.filter(m => m.id !== id));
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const draftLen = draft.trim().length;
  const overLimit = draftLen > BODY_MAX;
  const canSend = !sending && draftLen >= 1 && !overLimit;

  // ── Launcher (closed) ────────────────────────────────────────
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={unread > 0 ? `Open Smack Board (${unread} new)` : 'Open Smack Board'}
        title="Smack Board"
        style={{
          position: 'fixed',
          right: '1.25rem',
          bottom: '1.25rem',
          zIndex: 90,
          width: 56,
          height: 56,
          borderRadius: '50%',
          border: 'none',
          background: 'var(--green-dark, #1a2f1e)',
          color: '#fff',
          fontSize: '1.5rem',
          cursor: 'pointer',
          boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        💬
        {unread > 0 && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              top: -4,
              right: -4,
              minWidth: 22,
              height: 22,
              padding: '0 6px',
              borderRadius: 11,
              background: 'var(--red, #b3271a)',
              color: '#fff',
              fontSize: '0.72rem',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
            }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
    );
  }

  // ── Floating panel (open) ────────────────────────────────────
  const panelStyle: React.CSSProperties = isMobile
    ? {
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        width: '100vw',
        maxHeight: '100vh',
        background: 'var(--cream, #fafaf5)',
        borderRadius: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }
    : {
        position: 'fixed',
        right: '1.25rem',
        bottom: '1.25rem',
        zIndex: 100,
        width: 'min(380px, calc(100vw - 2.5rem))',
        maxHeight: 'min(620px, calc(100vh - 2.5rem))',
        background: 'var(--cream, #fafaf5)',
        borderRadius: 10,
        boxShadow: '0 12px 32px rgba(0,0,0,0.28)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        border: '1px solid var(--cream-dark, #e5e1d4)',
      };

  return (
    <>
      {/* Mobile-only backdrop — fills the screen behind the full-screen
          panel and closes it on tap. Desktop skips it entirely. */}
      {isMobile && (
        <div
          onClick={() => setOpen(false)}
          aria-hidden
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.35)',
            zIndex: 99,
          }}
        />
      )}

      <div
        role="dialog"
        aria-label={`Smack Board — ${tournamentName}`}
        style={panelStyle}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.5rem',
          padding: '0.75rem 0.9rem',
          background: 'var(--green-dark, #1a2f1e)',
          color: '#fff',
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontFamily: "'Playfair Display', serif",
              fontSize: '1.05rem', fontWeight: 700, lineHeight: 1.2,
            }}>
              💬 Smack Board
            </div>
            <div style={{
              fontSize: '0.72rem',
              color: 'rgba(255,255,255,0.65)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {tournamentName} · resets each tournament
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close Smack Board"
            title="Close"
            style={{
              flexShrink: 0,
              width: 32, height: 32,
              border: 'none', background: 'transparent',
              color: '#fff', fontSize: '1.25rem',
              cursor: 'pointer', borderRadius: 6,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* Thread — flex:1 so it grows and scrolls while compose stays pinned. */}
        <div style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          padding: '0.75rem 0.9rem',
          display: 'flex', flexDirection: 'column', gap: '0.55rem',
        }}>
          {!loaded && (
            <p style={{ color: 'var(--slate-mid)', fontSize: '0.85rem' }}>Loading…</p>
          )}
          {loaded && loadError && (
            <div className="alert alert-error" role="alert">{loadError}</div>
          )}
          {loaded && !loadError && messages.length === 0 && (
            <p style={{ color: 'var(--slate-mid)', fontSize: '0.88rem', lineHeight: 1.5 }}>
              Crickets. Be the first to weigh in — the board resets when
              the next tournament starts.
            </p>
          )}
          {messages.map(m => (
            <MessageRow
              key={m.id}
              msg={m}
              isOwn={m.user_id === currentUserId}
              onDelete={m.canDelete ? () => deleteMessage(m.id) : undefined}
            />
          ))}
        </div>

        {/* Compose — pinned to the bottom of the panel. */}
        <div style={{
          padding: '0.65rem 0.9rem 0.8rem',
          borderTop: '1px solid var(--cream-dark, #e5e1d4)',
          display: 'flex', flexDirection: 'column', gap: '0.4rem',
          background: 'var(--cream, #fafaf5)',
        }}>
          <textarea
            className="input"
            placeholder="Say something the group will regret reading…"
            rows={2}
            maxLength={BODY_MAX + 50}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={sending}
            style={{ resize: 'none', minHeight: '3.2rem', fontFamily: 'inherit' }}
            aria-label="Write a smack-board message"
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
            <span style={{
              fontSize: '0.75rem',
              color: overLimit ? 'var(--red)' : 'var(--slate-mid)',
            }}>
              {draftLen} / {BODY_MAX}
              {overLimit && ' — too long'}
            </span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!canSend}
              aria-busy={sending}
              onClick={send}
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
          {sendErr && (
            <div className="alert alert-error" role="alert">{sendErr}</div>
          )}
        </div>
      </div>

    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Row
// ─────────────────────────────────────────────────────────────

function MessageRow({
  msg, isOwn, onDelete,
}: {
  msg:      MessageView;
  isOwn:    boolean;
  onDelete?: () => void;
}) {
  const rel = useRelativeTime(msg.created_at);
  return (
    <div style={{
      padding: '0.55rem 0.65rem',
      borderRadius: 6,
      background: isOwn ? 'rgba(26, 47, 30, 0.06)' : 'rgba(0, 0, 0, 0.03)',
      borderLeft: isOwn ? '3px solid var(--green-mid)' : '3px solid transparent',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.5rem' }}>
        <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>
          {msg.display_name}
          {isOwn && <span style={{ color: 'var(--slate-mid)', fontWeight: 400, marginLeft: '0.4rem', fontSize: '0.78rem' }}>(you)</span>}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <span style={{ color: 'var(--slate-mid)', fontSize: '0.75rem' }}>{rel}</span>
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              aria-label="Delete message"
              title="Delete message"
              style={{
                border: 'none', background: 'transparent', cursor: 'pointer',
                color: 'var(--slate-mid)', padding: '0 0.2rem', fontSize: '0.95rem',
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          )}
        </span>
      </div>
      <div style={{
        marginTop: '0.2rem',
        whiteSpace: 'pre-wrap',
        wordWrap: 'break-word',
        fontSize: '0.92rem',
        lineHeight: 1.4,
      }}>
        {msg.body}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Relative-time helper (minute granularity)
// ─────────────────────────────────────────────────────────────

function useRelativeTime(iso: string): string {
  return formatRelative(new Date(iso));
}

function formatRelative(d: Date): string {
  const ms = Date.now() - d.getTime();
  if (ms < 30_000) return 'just now';
  const m = Math.floor(ms / 60_000);
  if (m < 1)   return 'just now';
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
