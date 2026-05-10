'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { signIn } from 'next-auth/react';
import { AUTH_LIMITS } from '@/lib/auth-validation';

export default function SignUpPage() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail]             = useState('');
  const [password, setPassword]       = useState('');
  const [loading, setLoading]         = useState(false);
  const [topError, setTopError]       = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setTopError(''); setFieldErrors({}); setLoading(true);

    try {
      // ── 1. Create the account ──
      const res = await fetch('/api/auth/register', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          email,
          display_name: displayName,
          password,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.fieldErrors) setFieldErrors(data.fieldErrors);
        else setTopError(data.error ?? `Registration failed (HTTP ${res.status}).`);
        setLoading(false);
        return;
      }

      // ── 2. Auto-login ──
      // The user just told us their password; signing them in now
      // means they don't see "now log in" friction.
      const signInRes = await signIn('credentials', {
        email, password, redirect: false,
      });
      setLoading(false);
      if (!signInRes || signInRes.error) {
        // Account exists but login failed — surface and let them retry.
        setTopError(
          'Account created, but sign-in failed. Please go to the sign-in page.',
        );
        return;
      }
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      setLoading(false);
      setTopError(err instanceof Error ? err.message : String(err));
    }
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
          <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>🏌️</div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: '2rem', fontWeight: 900, marginBottom: '0.4rem' }}>
            Create Your Account
          </h1>
          <p style={{ color: 'var(--slate-mid)' }}>Free forever. No credit card required.</p>
        </div>

        <div className="card">
          <form onSubmit={handleSignUp} noValidate>
            {topError && <div className="alert alert-error">{topError}</div>}

            <div className="field">
              <label className="label" htmlFor="display_name">Your Name</label>
              <input
                id="display_name"
                className="input"
                type="text"
                required
                placeholder="Rory McLeague"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                maxLength={AUTH_LIMITS.DISPLAY_NAME_MAX}
                aria-invalid={!!fieldErrors.display_name}
                autoComplete="name"
              />
              {fieldErrors.display_name
                ? <p className="hint" style={{ color: 'var(--red)' }}>{fieldErrors.display_name}</p>
                : <p className="hint">This is how you&rsquo;ll appear on leaderboards.</p>}
            </div>

            <div className="field">
              <label className="label" htmlFor="email">Email</label>
              <input
                id="email"
                className="input"
                type="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                aria-invalid={!!fieldErrors.email}
              />
              {fieldErrors.email && (
                <p className="hint" style={{ color: 'var(--red)' }}>{fieldErrors.email}</p>
              )}
            </div>

            <div className="field">
              <label className="label" htmlFor="password">Password</label>
              <input
                id="password"
                className="input"
                type="password"
                required
                autoComplete="new-password"
                placeholder={`Min. ${AUTH_LIMITS.PASSWORD_MIN} characters`}
                minLength={AUTH_LIMITS.PASSWORD_MIN}
                maxLength={AUTH_LIMITS.PASSWORD_MAX}
                value={password}
                onChange={e => setPassword(e.target.value)}
                aria-invalid={!!fieldErrors.password}
              />
              {fieldErrors.password && (
                <p className="hint" style={{ color: 'var(--red)' }}>{fieldErrors.password}</p>
              )}
            </div>

            <button type="submit" className="btn btn-primary btn-full btn-lg" disabled={loading} aria-busy={loading} style={{ marginTop: '0.5rem' }}>
              {loading ? 'Creating account…' : 'Create Account →'}
            </button>
          </form>
        </div>

        <p style={{ textAlign: 'center', color: 'var(--slate-mid)', fontSize: '0.875rem', marginTop: '1.25rem' }}>
          Already have an account?{' '}
          <Link href="/auth/signin" style={{ color: 'var(--green-mid)', fontWeight: 700, textDecoration: 'none' }}>
            Sign in →
          </Link>
        </p>
      </div>
    </div>
  );
}
