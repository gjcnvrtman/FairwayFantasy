'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { signIn } from 'next-auth/react';

// ``useSearchParams()`` must be wrapped in a ``<Suspense>`` boundary or
// ``next build`` errors the static-export of this page with
// "useSearchParams() should be wrapped in a suspense boundary at page
// /auth/signin". Splitting the form into an inner client component lets
// the page itself render without reading the URL until the inner
// component hydrates.
function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const redirect = params.get('redirect') || '/dashboard';

  const [email, setEmail]         = useState('');
  const [password, setPassword]   = useState('');
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  // Set to true when the signin failed specifically because the user
  // hasn't verified their email yet — toggles the Resend UI.
  const [needsVerify, setNeedsVerify] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendNote, setResendNote] = useState('');

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setNeedsVerify(false); setResendNote(''); setLoading(true);
    // `redirect: false` lets us own the post-signin navigation
    // (and surface the error inline rather than via a query string).
    const res = await signIn('credentials', { email, password, redirect: false });
    setLoading(false);
    if (!res || res.error) {
      // Auth.js v5 surfaces our CredentialsSignin subclass's `code`
      // field as `res.code`. Distinguish unverified-email from generic
      // bad-creds so users get actionable copy.
      if ((res as { code?: string } | undefined)?.code === 'EmailNotVerified') {
        setNeedsVerify(true);
        setError('Please verify your email before signing in. Check your inbox for a link from Fairway Fantasy.');
        return;
      }
      setError('Invalid email or password.');
      return;
    }
    router.push(redirect);
    router.refresh();
  }

  async function handleResend() {
    if (!email) {
      setResendNote('Enter your email above first.');
      return;
    }
    setResending(true); setResendNote('');
    try {
      const res = await fetch('/api/auth/resend-verify', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResendNote(data.error || `Couldn’t resend (HTTP ${res.status}).`);
      } else {
        setResendNote('If an account exists for that email and it isn’t already verified, a new link has been sent.');
      }
    } catch (err) {
      setResendNote(err instanceof Error ? err.message : String(err));
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="page-shell" style={{ background: 'var(--cream)', justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0 }}>
        <nav className="nav">
          <div className="nav-inner">
            <Link href="/" className="nav-logo">Fairway <span>Fantasy</span></Link>
          </div>
        </nav>
      </div>

      <div className="container-sm" style={{ paddingTop: '6rem', paddingBottom: '3rem' }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>⛳</div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: '2rem', fontWeight: 900, marginBottom: '0.4rem' }}>Welcome back</h1>
          <p style={{ color: 'var(--slate-mid)' }}>Sign in to your Fairway Fantasy account.</p>
        </div>

        <div className="card">
          <form onSubmit={handleSignIn}>
            {error && (
              <div className="alert alert-error">
                {error}
                {needsVerify && (
                  <div style={{ marginTop: '0.75rem' }}>
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={handleResend}
                      disabled={resending}
                      aria-busy={resending}
                    >
                      {resending ? 'Sending…' : 'Resend verification email'}
                    </button>
                    {resendNote && (
                      <p className="hint" style={{ marginTop: '0.5rem', color: 'var(--slate-mid)' }}>
                        {resendNote}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="field">
              <label className="label">Email</label>
              <input className="input" type="email" required autoComplete="email"
                placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} />
            </div>

            <div className="field">
              <label className="label">Password</label>
              <input className="input" type="password" required autoComplete="current-password"
                placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} />
            </div>

            <button type="submit" className="btn btn-primary btn-full btn-lg" disabled={loading} style={{ marginTop: '0.5rem' }}>
              {loading ? 'Signing in…' : 'Sign In →'}
            </button>
          </form>
        </div>

        <p style={{ textAlign: 'center', color: 'var(--slate-mid)', fontSize: '0.875rem', marginTop: '1.25rem' }}>
          No account?{' '}
          <Link href="/auth/signup" style={{ color: 'var(--green-mid)', fontWeight: 700, textDecoration: 'none' }}>
            Create one →
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={
      <div className="page-shell" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <p style={{ color: 'var(--slate-mid)' }}>Loading…</p>
      </div>
    }>
      <SignInForm />
    </Suspense>
  );
}
