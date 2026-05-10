'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { signIn } from 'next-auth/react';
import { AUTH_LIMITS } from '@/lib/auth-validation';

// `useSearchParams()` must be wrapped in a `<Suspense>` boundary or
// `next build` errors the static-export of this page (same constraint
// the signin page already obeys). Splitting the form into an inner
// client component lets the page itself render without reading the
// URL until the inner component hydrates.
function SignUpForm() {
  const router = useRouter();
  const params = useSearchParams();
  // Honour `?redirect=…` so an invitee who clicks Create Account
  // from a `/join/<slug>/<code>` page lands back on the invite,
  // not on the dashboard. signin/page.tsx does the same thing.
  const redirect = params.get('redirect') || '/dashboard';

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
        // Pass the redirect along so the signin page sends them back
        // to the invite once they sort out the password.
        setTopError(
          `Account created, but sign-in failed. Try the sign-in page${
            redirect !== '/dashboard' ? ' — your invite is waiting' : ''
          }.`,
        );
        return;
      }
      router.push(redirect);
      router.refresh();
    } catch (err) {
      setLoading(false);
      setTopError(err instanceof Error ? err.message : String(err));
    }
  }

  // If we came from an invite link, surface that context so the
  // user understands why they're signing up before they get to do it.
  const fromInvite = redirect.startsWith('/join/');

  // Build the signin URL preserving any redirect.
  const signInHref = redirect !== '/dashboard'
    ? `/auth/signin?redirect=${encodeURIComponent(redirect)}`
    : '/auth/signin';

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
          <p style={{ color: 'var(--slate-mid)' }}>
            {fromInvite
              ? 'You’ve been invited to a private golf league.'
              : 'Free forever. No credit card required.'}
          </p>
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
          <Link href={signInHref} style={{ color: 'var(--green-mid)', fontWeight: 700, textDecoration: 'none' }}>
            Sign in →
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function SignUpPage() {
  return (
    <Suspense fallback={
      <div className="page-shell" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <p style={{ color: 'var(--slate-mid)' }}>Loading…</p>
      </div>
    }>
      <SignUpForm />
    </Suspense>
  );
}
