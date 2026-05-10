'use client';

// Error boundary for /league/[slug] and its sub-tree. If the server
// component throws (Supabase down, malformed slug, RLS surprise) Next
// renders this instead of the full white-screen-of-death.
//
// Note: error.tsx files MUST be Client Components per the Next 14
// App Router contract.

import Link from 'next/link';
import { useEffect } from 'react';

export default function LeagueError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log to console; once we add server-side error logging we'll
    // ship this to whatever sink we land on. Don't surface the stack
    // to the user — just the message.
    console.error('League dashboard render error:', error);
  }, [error]);

  return (
    <div className="page-shell">
      <div className="page-content" style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        minHeight: 'calc(100vh - 80px)',
      }}>
        <div className="container-sm" style={{ textAlign: 'center', padding: '2.5rem 1.5rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '0.75rem' }}>⛳</div>
          <h1 style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: 'clamp(1.5rem,4vw,2rem)', fontWeight: 900,
            marginBottom: '0.5rem',
          }}>
            Couldn&rsquo;t load this league
          </h1>
          <p style={{ color: 'var(--slate-mid)', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
            Something went wrong. Try again, or head back to your dashboard.
          </p>
          {error.digest && (
            <p style={{ color: 'var(--slate-light)', fontSize: '0.72rem', marginBottom: '1.5rem' }}>
              Reference: <code>{error.digest}</code>
            </p>
          )}
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button onClick={reset} className="btn btn-primary">Try again</button>
            <Link href="/dashboard" className="btn btn-outline">Back to my leagues</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
