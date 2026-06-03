'use client';
import { useState } from 'react';
import Link from 'next/link';

export default function ForgotPasswordPage() {
  const [email, setEmail]     = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent]       = useState(false);
  const [error, setError]     = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Couldn't send reset email (HTTP ${res.status}).`);
        return;
      }
      // The API returns ok:true regardless of whether the email exists.
      // Show the same confirmation either way — don't let a UI signal
      // leak account enumeration.
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
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
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: '2rem', fontWeight: 900, marginBottom: '0.4rem' }}>
            Forgot password?
          </h1>
          <p style={{ color: 'var(--slate-mid)' }}>
            Enter your email and we&apos;ll send you a link to reset it.
          </p>
        </div>

        <div className="card">
          {sent ? (
            <div>
              <div className="alert alert-success" style={{ marginBottom: '1rem' }}>
                If an account exists for <strong>{email}</strong>, a reset link is on its way.
                The link expires in 1 hour.
              </div>
              <p className="hint" style={{ marginBottom: '1rem' }}>
                Didn&apos;t see it? Check your spam folder, or wait a minute and try again.
              </p>
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => { setSent(false); setError(''); }}
                >
                  Try a different email
                </button>
                <Link href="/auth/signin" className="btn btn-primary">
                  Back to sign in
                </Link>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              {error && <div className="alert alert-error">{error}</div>}

              <div className="field">
                <label className="label" htmlFor="forgot-email">Email</label>
                <input
                  id="forgot-email"
                  type="email"
                  className="input"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  disabled={loading}
                />
              </div>

              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading || !email}
                aria-busy={loading}
                style={{ width: '100%' }}
              >
                {loading ? 'Sending…' : 'Send reset link'}
              </button>

              <p className="hint" style={{ marginTop: '1rem', textAlign: 'center' }}>
                Remembered it?{' '}
                <Link href="/auth/signin" style={{ color: 'var(--brass)', fontWeight: 600 }}>
                  Back to sign in
                </Link>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
