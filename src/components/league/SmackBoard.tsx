'use client';

// ─────────────────────────────────────────────────────────────
// SMACK BOARD — per-tournament chat thread rendered below the
// active-tournament leaderboard. Polls every 20s when expanded.
// Newest message at the top so the latest takes don't get buried.
//
// Each row:
//   • author display_name + relative time
//   • body
//   • optional ✕ delete button (own message OR commissioner/co)
//
// Compose box at the bottom: textarea, Enter to send,
// Shift+Enter for newline, Send button.
//
// Collapse state — the title bar always renders so the user
// knows the board exists; the messages + compose collapse to a
// single line when toggled off. Persisted per league+tournament
// in localStorage so the choice survives navigation.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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

const POLL_MS = 20_000;
const BODY_MAX = 500;

function lastSeenKey(slug: string, tournamentId: string) {
  return `smackboard:lastSeen:${slug}:${tournamentId}`;
}

export default function SmackBoard({ slug, tournamentId, tournamentName, currentUserId }: Props) {
  const [messages,  setMessages]  = useState<MessageView[]>([]);
  const [loaded,    setLoaded]    = useState(false);
  const [loadError, setLoadError] = useState('');

  const [draft,    setDraft]   = useState('');
  const [sending,  setSending] = useState(false);
  const [sendErr,  setSendErr] = useState('');

  // collapsed — always starts expanded on page load. NOT persisted to
  // localStorage (Greg's call 2026-06-12, second iteration: the chat
  // should auto-open every visit; the collapse button is just for
  // momentary hiding within a session). lastSeen still uses localStorage
  // because the unread badge needs to remember the last reading point
  // across visits — different concern from open/closed UI state.
  const [collapsed, setCollapsed] = useState(false);
  const [lastSeen,  setLastSeen]  = useState<number>(0);

  // The "tick" state forces a re-render every minute so relative
  // timestamps ("3m ago") stay fresh without re-polling.
  const [, setTick] = useState(0);

  const visibleRef = useRef(true);

  // ── localStorage hydration — lastSeen only (collapsed always
  //    starts expanded; see comment on useState).
  useEffect(() => {
    try {
      const ls = window.localStorage.getItem(lastSeenKey(slug, tournamentId));
      if (ls) setLastSeen(Number(ls) || 0);
    } catch { /* private-mode / SSR — ignore */ }
  }, [slug, tournamentId]);

  // When the board expands, mark "now" as seen so the unread badge
  // clears. Expanding === reading.
  useEffect(() => {
    if (collapsed) return;
    const now = Date.now();
    setLastSeen(now);
    try { window.localStorage.setItem(lastSeenKey(slug, tournamentId), String(now)); }
    catch { /* ignore */ }
  }, [collapsed, slug, tournamentId]);

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

  // Initial load + poll loop. Polls regardless of collapse state so
  // the unread badge stays accurate; the only thing collapse changes
  // is the rendered thread/compose section.
  useEffect(() => {
    const ctrl = new AbortController();
    reload(ctrl.signal);

    const id = window.setInterval(() => {
      if (!visibleRef.current) return;
      reload();
    }, POLL_MS);

    const onVis = () => { visibleRef.current = document.visibilityState === 'visible'; };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      ctrl.abort();
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [reload]);

  // Tick the relative-time clock every 60s while the body is shown.
  useEffect(() => {
    if (collapsed) return;
    const id = window.setInterval(() => setTick(t => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, [collapsed]);

  // Unread = messages newer than lastSeen, excluding your own. Until
  // loaded is true the count would inflate every message; gate the
  // badge so it only appears once the message list is known.
  const unread = useMemo(() => {
    if (!loaded || !collapsed) return 0;
    return messages.filter(m => {
      if (m.user_id === currentUserId) return false;
      const t = Date.parse(m.created_at);
      return Number.isFinite(t) && t > lastSeen;
    }).length;
  }, [messages, lastSeen, currentUserId, loaded, collapsed]);

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

  return (
    <div className="card">
      {/* Header — always visible. Click anywhere to toggle. */}
      <button
        type="button"
        onClick={() => setCollapsed(c => !c)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand Smack Board' : 'Collapse Smack Board'}
        style={{
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          flexWrap: 'wrap', gap: '0.5rem',
          width: '100%', background: 'transparent', border: 'none', padding: 0,
          cursor: 'pointer', textAlign: 'left', font: 'inherit', color: 'inherit',
        }}
      >
        <h2 style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: '1.3rem', fontWeight: 700, marginBottom: '0.2rem',
        }}>
          💬 Smack Board
          {collapsed && unread > 0 && (
            <span
              style={{
                marginLeft: '0.5rem',
                padding: '0.05rem 0.45rem',
                borderRadius: 11,
                background: 'var(--red)',
                color: '#fff',
                fontSize: '0.72rem',
                fontWeight: 700,
                verticalAlign: 'middle',
              }}
            >
              {unread > 99 ? '99+' : unread} new
            </span>
          )}
        </h2>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <span style={{ color: 'var(--slate-mid)', fontSize: '0.8rem' }}>
            {tournamentName} · resets each tournament
          </span>
          <span
            aria-hidden
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: 6,
              background: 'var(--cream-dark)', color: 'var(--slate-mid)',
              fontSize: '1.1rem', lineHeight: 1,
            }}
          >
            {collapsed ? '+' : '−'}
          </span>
        </span>
      </button>

      {!collapsed && (
        <>
          {/* ── Compose ─────────────────────────────────────────── */}
          <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <textarea
              className="input"
              placeholder="Say something the group will regret reading…"
              rows={2}
              maxLength={BODY_MAX + 50 /* let them paste over, we still validate */}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={sending}
              style={{ resize: 'vertical', minHeight: '4.5rem', fontFamily: 'inherit' }}
              aria-label="Write a smack-board message"
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
              <span style={{
                fontSize: '0.78rem',
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

          {/* ── Thread ──────────────────────────────────────────── */}
          <div style={{
            marginTop: '1rem',
            maxHeight: 420,
            overflowY: 'auto',
            display: 'flex', flexDirection: 'column', gap: '0.6rem',
            paddingRight: '0.25rem',
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
        </>
      )}
    </div>
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
