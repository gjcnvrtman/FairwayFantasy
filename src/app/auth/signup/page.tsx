'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createBrowserSupabaseClient } from '@/lib/supabase';

export default function SignUpPage() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail]             = useState('');
  const [password, setPassword]       = useState('');
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const [success, setSuccess]         = useState(false);

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setLoading(true);

    if (password.length < 8) {
      setError('Password must be at least 8 characters.'); setLoading(false); return;
    }

    const supabase = createBrowserSupabaseClient();

    const { data, error: authError } = await supabase.auth.signUp({
      email, password,
      options: {
        data: { display_name: displayName },
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (authError) { setError(authError.message); setLoading(false); return; }

    // Create profile row
    if (data.user) {
      await supabase.from('profiles').insert({
        id: data.user.id,
        display_name: displayName,
        email,
      });
    }

    setLoading(false);
    setSuccess(true);
  }

  if (success) {
    return (
      <div className="page-shell" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div className="container-sm" style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>✉️</div>
          <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.8rem', marginBottom: '0.75rem' }}>Check your email</h2>
          <p style={{ color: 'var(--slate-mid)', marginBottom: '1.5rem' }}>
            We sent a confirmation link to <strong>{email}</strong>. Click it to activate your account.
          </p>
          <Link href="/auth/signin" className="btn btn-primary">Back to Sign In</Link>
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
          <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>🏌️</div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: '2rem', fontWeight: 900, marginBottom: '0.4rem' }}>
            Create Your Account
          </h1>
          <p style={{ color: 'var(--slate-mid)' }}>Free forever. No credit card required.</p>
        </div>

        <div className="card">
          <form onSubmit={handleSignUp}>
            {error && <div className="alert alert-error">{error}</div>}

            <div className="field">
              <label className="label">Your Name</label>
              <input className="input" type="text" required placeholder="Rory McLeague"
                value={displayName} onChange={e => setDisplayName(e.target.value)} maxLength={40} />
              <p className="hint">This is how you&rsquo;ll appear on leaderboards.</p>
            </div>

            <div className="field">
              <label className="label">Email</label>
              <input className="input" type="email" required autoComplete="email"
                placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} />
            </div>

            <div className="field">
              <label className="label">Password</label>
              <input className="input" type="password" required autoComplete="new-password"
                placeholder="Min. 8 characters" value={password} onChange={e => setPassword(e.target.value)} />
            </div>

            <button type="submit" className="btn btn-primary btn-full btn-lg" disabled={loading} style={{ marginTop: '0.5rem' }}>
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
