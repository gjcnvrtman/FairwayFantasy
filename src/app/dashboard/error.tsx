'use client';

import Link from 'next/link';
import { useEffect } from 'react';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Dashboard render error:', error);
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
            Couldn&rsquo;t load your dashboard
          </h1>
          <p style={{ color: 'var(--slate-mid)', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
            Try again — if it keeps failing, sign out and back in.
          </p>
          {error.digest && (
            <p style={{ color: 'var(--slate-light)', fontSize: '0.72rem', marginBottom: '1.5rem' }}>
              Reference: <code>{error.digest}</code>
            </p>
          )}
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button onClick={reset} className="btn btn-primary">Try again</button>
            <Link href="/" className="btn btn-outline">Home</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
