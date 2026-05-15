'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';

// Wrapped in Suspense because useSearchParams() must be — same
// constraint signin/signup pages already obey for static-export.
function VerifyContent() {
  const params = useSearchParams();
  const token  = params.get('token') ?? '';
  const [state, setState] = useState<'pending' | 'success' | 'expired' | 'invalid'>('pending');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    if (!token) {
      setState('invalid');
      setError('No verification token provided.');
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/auth/verify?token=${encodeURIComponent(token)}`);
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          setState('success');
          return;
        }
        if (data.expired) {
          setState('expired');
          setError(data.error || 'Link has expired.');
        } else {
          setState('invalid');
          setError(data.error || `Verification failed (HTTP ${res.status}).`);
        }
      } catch (err) {
        setState('invalid');
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [token]);

  return (
    <div className="page-shell" style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0 }}>
        <nav className="nav">
          <div className="nav-inner">
            <Link href="/" className="nav-logo">Fairway <span>Fantasy</span></Link>
          </div>
        </nav>
      </div>

      <div className="container-sm" style={{ paddingTop: '6rem', paddingBottom: '3rem', textAlign: 'center' }}>
        {state === 'pending' && (
          <>
            <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>⏳</div>
            <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: '2rem', fontWeight: 900 }}>
              Verifying your email…
            </h1>
          </>
        )}

        {state === 'success' && (
          <>
            <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>✅</div>
            <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: '2rem', fontWeight: 900 }}>
              Email verified!
            </h1>
            <p style={{ color: 'var(--slate-mid)', marginTop: '0.5rem' }}>
              You can sign in now and start picking your foursome.
            </p>
            <div style={{ marginTop: '1.5rem' }}>
              <Link href="/auth/signin" className="btn btn-primary btn-lg">
                Sign In →
              </Link>
            </div>
          </>
        )}

        {state === 'expired' && (
          <>
            <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>⏱️</div>
            <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: '2rem', fontWeight: 900 }}>
              Link expired
            </h1>
            <p style={{ color: 'var(--slate-mid)', marginTop: '0.5rem' }}>{error}</p>
            <p style={{ color: 'var(--slate-mid)', marginTop: '0.5rem' }}>
              Sign in to request a new verification email.
            </p>
            <div style={{ marginTop: '1.5rem' }}>
              <Link href="/auth/signin" className="btn btn-primary btn-lg">
                Sign In →
              </Link>
            </div>
          </>
        )}

        {state === 'invalid' && (
          <>
            <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>⚠️</div>
            <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: '2rem', fontWeight: 900 }}>
              Verification failed
            </h1>
            <p style={{ color: 'var(--slate-mid)', marginTop: '0.5rem' }}>{error}</p>
            <div style={{ marginTop: '1.5rem' }}>
              <Link href="/auth/signin" className="btn btn-primary btn-lg">
                Sign In →
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={<div />}>
      <VerifyContent />
    </Suspense>
  );
}
