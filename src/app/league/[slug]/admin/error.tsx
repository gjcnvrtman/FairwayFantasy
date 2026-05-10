'use client';

// Error boundary for /league/[slug]/admin. Caught failures land here
// — most likely Supabase blip on data fetch, or an unauthorized
// redirect race.

import Link from 'next/link';
import { useEffect } from 'react';
import { useParams } from 'next/navigation';

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const params = useParams();
  const slug = typeof params?.slug === 'string' ? params.slug : '';

  useEffect(() => {
    console.error('Admin panel render error:', error);
  }, [error]);

  return (
    <div className="page-shell">
      <div className="page-content" style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        minHeight: 'calc(100vh - 80px)',
      }}>
        <div className="container-sm" style={{ textAlign: 'center', padding: '2.5rem 1.5rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '0.75rem' }}>🛠️</div>
          <h1 style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: 'clamp(1.5rem,4vw,2rem)', fontWeight: 900,
            marginBottom: '0.5rem',
          }}>
            Couldn&rsquo;t load the admin panel
          </h1>
          <p style={{ color: 'var(--slate-mid)', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
            Try again in a second. If you keep seeing this, your session may have expired.
          </p>
          {error.digest && (
            <p style={{ color: 'var(--slate-light)', fontSize: '0.72rem', marginBottom: '1.5rem' }}>
              Reference: <code>{error.digest}</code>
            </p>
          )}
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button onClick={reset} className="btn btn-primary">Try again</button>
            {slug && <Link href={`/league/${slug}`} className="btn btn-outline">Back to league</Link>}
          </div>
        </div>
      </div>
    </div>
  );
}
