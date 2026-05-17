'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useSession } from 'next-auth/react';

export default function JoinLeaguePage() {
  const params       = useParams();
  const router       = useRouter();
  const searchParams = useSearchParams();
  const slug         = params.slug as string;
  const inviteCode   = params.code as string;
  // Email-prefill hint from the invite email's URL. Passed through to
  // /auth/signup so the recipient doesn't have to retype their address.
  const emailHint    = searchParams.get('email') ?? '';

  const [status, setStatus] = useState<'loading' | 'ready' | 'joining' | 'success' | 'error'>('loading');
  const [leagueName, setLeagueName] = useState('');
  const [error, setError] = useState('');

  // NextAuth session — `useSession()` returns `{ data, status }`.
  // We only care about whether there's a user; UI logic below.
  const session     = useSession();
  const sessionStat = session.status;          // 'loading' | 'authenticated' | 'unauthenticated'
  const isLoggedIn  = !!session.data?.user?.id;

  // Auto-join when the user lands here AFTER signing up (signup form
  // redirects to /join/<slug>/<code>?auto=1 once it's logged the new
  // user in). One-shot guard so a re-render can't fire it twice.
  const autoFlag       = searchParams.get('auto') === '1';
  const autoJoinedRef  = useRef(false);

  useEffect(() => {
    async function verify() {
      // Verify invite code is valid (public endpoint — no auth needed).
      const res = await fetch(`/api/leagues/verify?slug=${slug}&code=${inviteCode}`);
      if (!res.ok) {
        setError('This invite link is invalid or expired.'); setStatus('error'); return;
      }
      const data = await res.json();
      setLeagueName(data.leagueName);
      setStatus('ready');
    }
    verify();
  }, [slug, inviteCode]);

  // Once the invite is verified AND we know the session state, decide
  // whether to push the visitor straight into signup (logged-out path).
  // We wait for `sessionStat !== 'loading'` so we don't redirect during
  // the brief window before useSession resolves.
  useEffect(() => {
    if (status !== 'ready') return;
    if (sessionStat === 'loading') return;
    if (isLoggedIn) return;
    // Build a redirect that keeps the auto-join flag so signup → join
    // resolves to /league/<slug> in one hop.
    const redirect = `/join/${slug}/${inviteCode}?auto=1${emailHint ? `&email=${encodeURIComponent(emailHint)}` : ''}`;
    const url = `/auth/signup?redirect=${encodeURIComponent(redirect)}`
              + (emailHint ? `&email=${encodeURIComponent(emailHint)}` : '');
    router.replace(url);
  }, [status, sessionStat, isLoggedIn, slug, inviteCode, emailHint, router]);

  async function handleJoin() {
    setStatus('joining');
    const res = await fetch('/api/leagues/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, inviteCode }),
    });
    const data = await res.json();
    if (!res.ok) { setError(data.error); setStatus('error'); return; }
    setStatus('success');
    setTimeout(() => router.push(`/league/${slug}`), 1500);
  }

  // Auto-join on landing for the signup → join handoff. Only fires
  // once and only when the URL explicitly opted in via ?auto=1.
  useEffect(() => {
    if (!autoFlag) return;
    if (status !== 'ready') return;
    if (!isLoggedIn) return;
    if (autoJoinedRef.current) return;
    autoJoinedRef.current = true;
    handleJoin();
    // handleJoin reads slug/inviteCode from closure; no deps needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFlag, status, isLoggedIn]);

  if (status === 'loading') {
    return (
      <div className="page-shell" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>⛳</div>
          <p style={{ color: 'var(--slate-mid)' }}>Checking invite…</p>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="page-shell" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div className="container-sm" style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>❌</div>
          <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.6rem', marginBottom: '0.75rem' }}>Invalid Invite</h2>
          <p style={{ color: 'var(--slate-mid)', marginBottom: '1.5rem' }}>{error}</p>
          <Link href="/dashboard" className="btn btn-primary">Go to Dashboard</Link>
        </div>
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div className="page-shell" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div className="container-sm" style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🎉</div>
          <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.8rem', marginBottom: '0.5rem' }}>You&rsquo;re in!</h2>
          <p style={{ color: 'var(--slate-mid)' }}>Redirecting you to {leagueName}…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell" style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0 }}>
        <nav className="nav">
          <div className="nav-inner">
            <Link href="/" className="nav-logo">Fairway <span>Fantasy</span></Link>
          </div>
        </nav>
      </div>

      <div className="container-sm" style={{ paddingTop: '6rem', paddingBottom: '3rem' }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>🤝</div>
          <p style={{ fontSize: '0.8rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--slate-mid)', marginBottom: '0.4rem' }}>
            You&rsquo;ve been invited to join
          </p>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: '2.2rem', fontWeight: 900, marginBottom: '0.5rem' }}>
            {leagueName}
          </h1>
          <p style={{ color: 'var(--slate-mid)' }}>
            A private golf fantasy league on Fairway Fantasy.
          </p>
        </div>

        <div className="card">
          {!isLoggedIn ? (
            <div>
              <p style={{ textAlign: 'center', color: 'var(--slate-mid)', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
                Create an account or sign in to join this league. Your invite link will still work after signing in.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <Link
                  href={`/auth/signup?redirect=/join/${slug}/${inviteCode}`}
                  className="btn btn-primary btn-full btn-lg"
                >
                  Create Account & Join →
                </Link>
                <Link
                  href={`/auth/signin?redirect=/join/${slug}/${inviteCode}`}
                  className="btn btn-outline btn-full"
                >
                  Sign In
                </Link>
              </div>
            </div>
          ) : (
            <div>
              <div className="alert alert-info" style={{ marginBottom: '1.25rem' }}>
                📋 Joining this league means you&rsquo;ll pick golfers for each PGA Tour event and the four Majors.
              </div>
              <button
                className="btn btn-primary btn-full btn-lg"
                onClick={handleJoin}
                disabled={status === 'joining'}
              >
                {status === 'joining' ? 'Joining…' : `Join ${leagueName} →`}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
