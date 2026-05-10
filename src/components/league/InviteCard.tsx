'use client';

// ─────────────────────────────────────────────────────────────
// InviteCard — commissioner / member invite-link share card.
//
// Why a separate Client Component:
//   The league page (/league/[slug]/page.tsx) is a Server Component
//   (it does Supabase auth + RSC data fetching). Bug #4.9 was that
//   the page included an inline ``onClick`` on a copy button without
//   ``'use client'`` — that compiles, but throws a runtime error
//   when the button is actually clicked. Lifting the interactive
//   button into this client component fixes that for good.
//
// Behavior:
//   - Shows the bare path (``/join/<slug>/<code>``) in a monospace
//     label so a user can read off the URL on a small screen.
//   - Copy button writes the absolute ``inviteUrl`` to the clipboard,
//     then flashes "Copied!" for 2.5 s.
//   - Falls back to ``document.execCommand('copy')`` when
//     ``navigator.clipboard`` is unavailable (older browsers, the
//     LAN-only http context where clipboard API is gated on HTTPS).
// ─────────────────────────────────────────────────────────────

import { useState } from 'react';

interface Props {
  /** The full URL that should land in the user's clipboard. */
  inviteUrl: string;
  /** Bare invite path shown to the user (e.g. ``/join/foo/ABC123``). */
  invitePath: string;
  /** Optional title override. Default: "Invite Players". */
  title?: string;
  /** Optional subhead. */
  subhead?: string;
}

export default function InviteCard({
  inviteUrl,
  invitePath,
  title   = 'Invite Players',
  subhead = 'Share this link — anyone who clicks it can join.',
}: Props) {
  const [copied, setCopied] = useState(false);
  const [error,  setError]  = useState('');

  async function copy() {
    setError('');
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
      setError(`Couldn't copy. ${err instanceof Error ? err.message : ''}`.trim());
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
      {error && (
        <p style={{
          marginTop: '0.5rem',
          fontSize:  '0.72rem',
          color:     'rgba(255,255,255,0.7)',
        }}>
          {error} You can copy the path above manually.
        </p>
      )}
    </div>
  );
}
