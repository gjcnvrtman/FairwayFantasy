'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { createBrowserSupabaseClient } from '@/lib/supabase';

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

  const [email, setEmail]     = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setLoading(true);
    const supabase = createBrowserSupabaseClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) { setError(error.message); return; }
    router.push(redirect);
    router.refresh();
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
            {error && <div className="alert alert-error">{error}</div>}

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
