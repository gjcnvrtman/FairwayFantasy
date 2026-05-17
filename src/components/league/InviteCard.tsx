'use client';

// ─────────────────────────────────────────────────────────────
// InviteCard — commissioner / member invite-link share card.
//
// Two side-by-side affordances:
//   1. Copy the invite URL to the clipboard (works on http LAN too
//      via execCommand fallback). Always available.
//   2. Send the invite link by email to one or more addresses via
//      POST /api/leagues/invite-by-email. Only available when the
//      caller passed `slug` (i.e. inside the league dashboard). The
//      route requires a logged-in league member and is rate-limited.
//
// Why a client component:
//   The league page (/league/[slug]/page.tsx) is a Server Component
//   doing data fetching. Bug #4.9 was an inline onClick on a copy
//   button without 'use client' — that compiles but throws at click
//   time. Lifting the interactive surface into this client component
//   fixes both the copy AND new email-send buttons.
// ─────────────────────────────────────────────────────────────

import { useState } from 'react';

interface Props {
  /** The full URL that should land in the user's clipboard and email body. */
  inviteUrl: string;
  /** Bare invite path shown to the user (e.g. ``/join/foo/ABC123``). */
  invitePath: string;
  /** League slug — when set, enables the "Send by email" affordance. */
  slug?: string;
  /** Optional title override. Default: "Invite Players". */
  title?: string;
  /** Optional subhead. */
  subhead?: string;
}

interface SendResult {
  sent:   string[];
  failed: Array<{ email: string; reason: string }>;
}

export default function InviteCard({
  inviteUrl,
  invitePath,
  slug,
  title   = 'Invite Players',
  subhead = 'Share this link — anyone who clicks it can join.',
}: Props) {
  const [copied, setCopied] = useState(false);
  const [copyErr, setCopyErr] = useState('');

  // Email-send UI state. emailsRaw is the literal textarea content;
  // we let the server do the normalisation rather than reproducing it
  // here, but show a quick count of detected addresses to the user.
  const [emailsRaw, setEmailsRaw] = useState('');
  const [sending,   setSending]   = useState(false);
  const [sendErr,   setSendErr]   = useState('');
  const [sendOk,    setSendOk]    = useState<SendResult | null>(null);

  async function copy() {
    setCopyErr('');
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(inviteUrl);
      } else {
        // Fallback for http LAN deployments where the Clipboard API
        // isn't available (it requires a secure context).
        const ta = document.createElement('textarea');
        ta.value = inviteUrl;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (!ok) throw new Error('Browser refused to copy');
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (err) {
      setCopyErr(`Couldn't copy. ${err instanceof Error ? err.message : ''}`.trim());
    }
  }

  // Split textarea on common separators (commas, semicolons, whitespace,
  // newlines) so users can paste a CSV / comma-separated list / one
  // per line without thinking. Server re-normalises identically.
  function parseEmails(raw: string): string[] {
    return raw
      .split(/[\s,;]+/)
      .map(s => s.trim())
      .filter(Boolean);
  }
  const parsedEmails = parseEmails(emailsRaw);

  async function send() {
    if (!slug) return; // shouldn't happen — UI gates on slug
    setSendErr('');
    setSendOk(null);
    if (parsedEmails.length === 0) {
      setSendErr('Enter at least one email address.');
      return;
    }
    setSending(true);
    try {
      const res = await fetch('/api/leagues/invite-by-email', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ slug, emails: parsedEmails }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSendErr(data.error || `Failed (HTTP ${res.status})`);
        return;
      }
      setSendOk({ sent: data.sent || [], failed: data.failed || [] });
      // Clear the input on full success so subsequent batches start fresh.
      if ((data.failed?.length ?? 0) === 0) setEmailsRaw('');
    } catch (err) {
      setSendErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="card card-green">
      <h3 style={{
        fontFamily: "'Playfair Display', serif",
        fontSize:    '1rem',
        fontWeight:  700,
        marginBottom: '0.4rem',
      }}>
        {title}
      </h3>
      <p style={{
        color: 'rgba(255,255,255,0.55)',
        fontSize: '0.8rem',
        marginBottom: '1rem',
      }}>
        {subhead}
      </p>

      {/* ── Path + copy ─────────────────────────────────────── */}
      <div
        style={{
          background:   'rgba(255,255,255,0.08)',
          borderRadius: 8,
          padding:      '0.6rem 0.75rem',
          fontSize:     '0.75rem',
          fontFamily:   'monospace',
          color:        'var(--brass-light)',
          wordBreak:    'break-all',
          marginBottom: '0.75rem',
        }}
        aria-label="Invite link path"
      >
        {invitePath}
      </div>
      <button
        type="button"
        className="btn btn-brass btn-sm btn-full"
        onClick={copy}
        aria-label={copied ? 'Invite link copied' : 'Copy invite link to clipboard'}
      >
        {copied ? '✓ Copied!' : '📋 Copy Invite Link'}
      </button>
      {copyErr && (
        <p style={{
          marginTop: '0.5rem',
          fontSize:  '0.72rem',
          color:     'rgba(255,255,255,0.7)',
        }}>
          {copyErr} You can copy the path above manually.
        </p>
      )}

      {/* ── Email send (only when we know the league slug) ───── */}
      {slug && (
        <div style={{
          marginTop: '1.25rem',
          paddingTop: '1rem',
          borderTop: '1px solid rgba(255,255,255,0.15)',
        }}>
          <label
            htmlFor="invite-emails"
            style={{
              display: 'block',
              fontSize: '0.8rem',
              fontWeight: 600,
              color: 'rgba(255,255,255,0.85)',
              marginBottom: '0.4rem',
            }}
          >
            Or send by email
          </label>
          <p style={{
            color: 'rgba(255,255,255,0.5)',
            fontSize: '0.72rem',
            marginBottom: '0.5rem',
          }}>
            One or more addresses, separated by commas, spaces, or new lines.
          </p>
          <textarea
            id="invite-emails"
            value={emailsRaw}
            onChange={(e) => setEmailsRaw(e.target.value)}
            disabled={sending}
            rows={3}
            placeholder="alice@example.com, bob@example.com"
            style={{
              width: '100%',
              padding: '0.5rem 0.6rem',
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 6,
              color: 'var(--cream-light)',
              fontSize: '0.82rem',
              fontFamily: 'monospace',
              resize: 'vertical',
              marginBottom: '0.5rem',
              boxSizing: 'border-box',
            }}
          />
          <button
            type="button"
            className="btn btn-brass btn-sm btn-full"
            onClick={send}
            disabled={sending || parsedEmails.length === 0}
            aria-busy={sending}
          >
            {sending
              ? 'Sending…'
              : parsedEmails.length === 0
                ? '✉️ Send Invite'
                : `✉️ Send Invite (${parsedEmails.length})`}
          </button>
          {sendErr && (
            <p style={{
              marginTop: '0.5rem',
              fontSize: '0.75rem',
              color: 'rgba(255,200,200,0.95)',
            }}>
              {sendErr}
            </p>
          )}
          {sendOk && (
            <div style={{
              marginTop: '0.5rem',
              fontSize: '0.75rem',
              color: 'rgba(255,255,255,0.85)',
              lineHeight: 1.4,
            }}>
              {sendOk.sent.length > 0 && (
                <p style={{ margin: 0 }}>
                  ✓ Sent to {sendOk.sent.length}: <span style={{ fontFamily: 'monospace' }}>{sendOk.sent.join(', ')}</span>
                </p>
              )}
              {sendOk.failed.length > 0 && (
                <p style={{ margin: '0.25rem 0 0 0', color: 'rgba(255,200,200,0.95)' }}>
                  ✗ Failed: {sendOk.failed.map(f => `${f.email} (${f.reason})`).join(', ')}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
