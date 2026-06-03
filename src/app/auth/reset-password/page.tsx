'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { validatePassword, AUTH_LIMITS } from '@/lib/auth-validation';

// useSearchParams() must sit inside a <Suspense> boundary or
// `next build` errors on this route's static analysis. Splitting the
// form into an inner client component lets the page itself render
// without reading the URL until the inner component hydrates.

function ResetPasswordForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token  = params.get('token') ?? '';

  const [password, setPassword]               = useState('');
  const [confirm,  setConfirm]                = useState('');
  const [loading,  setLoading]                = useState(false);
  const [error,    setError]                  = useState('');
  const [done,     setDone]                   = useState(false);

  // Client-side mirror of the server's password rules — same shared
  // helper, so they can't drift.
  const liveError =
    password && validatePassword(password) ||
    confirm && password !== confirm ? 'Passwords don’t match.' :
    null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!token) {
      setError('This reset link is missing a token. Please request a new one.');
      return;
    }
    const pwError = validatePassword(password);
    if (pwError) {
      setError(pwError);
      return;
    }
    if (password !== confirm) {
      setError('Passwords don’t match.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Couldn’t reset (HTTP ${res.status}).`);
        return;
      }
      setDone(true);
      // Brief pause so the success message is visible before bouncing.
      setTimeout(() => {
        router.push('/auth/signin?reset=ok');
      }, 1800);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  // Missing-token branch — show a helpful message instead of a form
  // the user can't successfully submit.
  if (!token) {
    return (
      <div>
        <div className="alert alert-error" style={{ marginBottom: '1rem' }}>
          This page needs a reset token. The link in your email should look like
          <code style={{ marginLeft: '0.4rem' }}>/auth/reset-password?token=…</code>.
        </div>
        <Link href="/auth/forgot-password" className="btn btn-primary" style={{ width: '100%' }}>
          Request a new reset link
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className="alert alert-success">
        Your password has been reset. Redirecting to sign in…
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      {error && <div className="alert alert-error">{error}</div>}

      <div className="field">
        <label className="label" htmlFor="reset-pw">New password</label>
        <input
          id="reset-pw"
          type="password"
          className="input"
          required
          autoComplete="new-password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          disabled={loading}
          minLength={AUTH_LIMITS.PASSWORD_MIN}
        />
        <p className="hint" style={{ marginTop: '0.4rem' }}>
          At least {AUTH_LIMITS.PASSWORD_MIN} characters, with
          {' '}{AUTH_LIMITS.PASSWORD_MIN_CLASSES} of: lowercase, uppercase, digit, symbol.
        </p>
      </div>

      <div className="field">
        <label className="label" htmlFor="reset-pw-confirm">Confirm new password</label>
        <input
          id="reset-pw-confirm"
          type="password"
          className="input"
          required
          autoComplete="new-password"
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          disabled={loading}
        />
      </div>

      {liveError && (
        <p className="hint" style={{ marginBottom: '0.75rem', color: 'var(--red)' }}>
          {liveError}
        </p>
      )}

      <button
        type="submit"
        className="btn btn-primary"
        disabled={loading || !password || !confirm || password !== confirm}
        aria-busy={loading}
        style={{ width: '100%' }}
      >
        {loading ? 'Resetting…' : 'Set new password'}
      </button>

      <p className="hint" style={{ marginTop: '1rem', textAlign: 'center' }}>
        <Link href="/auth/signin" style={{ color: 'var(--brass)', fontWeight: 600 }}>
          Back to sign in
        </Link>
      </p>
    </form>
  );
}

export default function ResetPasswordPage() {
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
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: '2rem', fontWeight: 900, marginBottom: '0.4rem' }}>
            Set a new password
          </h1>
          <p style={{ color: 'var(--slate-mid)' }}>
            Choose a fresh password for your Fairway Fantasy account.
          </p>
        </div>

        <div className="card">
          <Suspense fallback={<div>Loading…</div>}>
            <ResetPasswordForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
