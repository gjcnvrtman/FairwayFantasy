'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';
import Link from 'next/link';
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

  // Parse the slug + invite code out of an invite-link redirect, if any.
  // Pattern: /join/<slug>/<code>. Stops at `/` AND `?` so a query
  // string after the code (e.g. `?auto=1&email=foo%40bar.com`)
  // doesn't get swallowed into the code group.
  // Bug 2026-05-17: with the loose `[^/]+` group the code captured
  // `F086Y9?auto=1&email=…` and register 403'd with "Invite link is
  // invalid", silently failing the form for Greg.
  const inviteFromRedirect = (() => {
    const m = redirect.match(/^\/join\/([^/?]+)\/([^/?]+)/);
    return m ? { slug: m[1], code: m[2] } : null;
  })();

  // Email prefill from the invite email's `?email=` URL param. Greg
  // 2026-05-17: invite recipients shouldn't have to retype an address
  // we already sent the link to.
  const emailPrefill = params.get('email') ?? '';

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail]             = useState(emailPrefill);
  const [password, setPassword]       = useState('');
  // Pre-fill from the redirect path when arriving via an invite link.
  const [leagueSlug, setLeagueSlug]   = useState(inviteFromRedirect?.slug ?? '');
  const [inviteCode, setInviteCode]   = useState(inviteFromRedirect?.code ?? '');
  const [loading, setLoading]         = useState(false);
  const [topError, setTopError]       = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // After a successful POST /api/auth/register we no longer auto-sign-in
  // (the user is unverified and would just bounce off the verify gate).
  // Show a "check your email" success panel instead.
  const [registered, setRegistered]   = useState<{ email: string; emailSent: boolean } | null>(null);

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
          leagueSlug,
          inviteCode,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.fieldErrors) {
          // In invite-flow mode the slug + code fields are hidden,
          // so a fieldErrors entry on leagueSlug / inviteCode would
          // attach to an invisible input and silently swallow the
          // error. Lift those messages to topError so the user
          // sees what went wrong. (Bug 2026-05-17: Greg's 403
          // signup attempts had no visible feedback.)
          const fe = data.fieldErrors as Record<string, string>;
          const inviteFieldMsgs = [
            inviteFromRedirect && fe.inviteCode,
            inviteFromRedirect && fe.leagueSlug,
          ].filter(Boolean).join(' ');
          if (inviteFieldMsgs) setTopError(inviteFieldMsgs);
          setFieldErrors(fe);
        } else {
          setTopError(data.error ?? `Registration failed (HTTP ${res.status}).`);
        }
        setLoading(false);
        return;
      }

      // ── 2a. Invite-flow auto-login (2026-05-17). Server marks the
      // new user's email_verified=true when the registration carries
      // a valid invite, so we can sign them in immediately and ship
      // them to the redirect (/join/<slug>/<code>?auto=1 → /league/).
      // No "check your email" gate in this path — they proved access
      // to the email by clicking the invite link, and the upstream
      // /join page won't let them get here without a verified invite.
      if (data.autoVerified) {
        const result = await signIn('credentials', {
          email,
          password,
          redirect: false,
        });
        setLoading(false);
        if (result?.ok) {
          router.push(redirect);
          return;
        }
        // Auto-login failed for some reason — fall back to the
        // verify panel so the user still has a clear next step.
        setTopError(result?.error ?? 'Account created but auto-login failed. Please sign in.');
        return;
      }

      // ── 2b. Non-invite (or non-auto-verified) path: show
      // "check your email". Verification link will redirect to
      // /auth/verify → /auth/signin.
      setLoading(false);
      setRegistered({ email, emailSent: !!data.emailSent });
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

        {registered ? (
          <div className="card" style={{ textAlign: 'center', padding: '2.5rem 1.5rem' }}>
            <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📧</div>
            <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem' }}>
              Check your email
            </h2>
            <p style={{ color: 'var(--slate-mid)', marginBottom: '0.75rem' }}>
              We sent a verification link to <strong>{registered.email}</strong>.
              Click the link to activate your account.
            </p>
            {!registered.emailSent && (
              <p className="alert alert-warn" style={{ fontSize: '0.85rem', textAlign: 'left' }}>
                ⚠️ The email couldn&rsquo;t be sent right now (SMTP issue). Use the
                &ldquo;Resend verification email&rdquo; option on the sign-in page once
                you have your password handy.
              </p>
            )}
            <p style={{ color: 'var(--slate-light)', fontSize: '0.85rem', marginTop: '1rem' }}>
              Didn&rsquo;t get it? Check spam, or try sign-in to resend.
            </p>
            <div style={{ marginTop: '1.25rem' }}>
              <Link href="/auth/signin" className="btn btn-primary btn-lg">
                Go to Sign In →
              </Link>
            </div>
          </div>
        ) : (
        <div className="card">
          <form onSubmit={handleSignUp} noValidate>
            {topError && <div className="alert alert-error">{topError}</div>}

            {/* Invite-only signup. If we arrived via /join/<slug>/<code>
                the fields are pre-filled and read-only; otherwise the
                user must paste a code from a commissioner's invite link. */}
            {inviteFromRedirect ? (
              <div className="alert alert-info" style={{ marginBottom: '1rem' }}>
                ✓ Invite verified — you&rsquo;re joining{' '}
                <strong>{inviteFromRedirect.slug}</strong>.
                <input type="hidden" name="leagueSlug" value={leagueSlug} />
                <input type="hidden" name="inviteCode" value={inviteCode} />
              </div>
            ) : (
              <>
                <div className="field">
                  <label className="label" htmlFor="leagueSlug">League Slug</label>
                  <input
                    id="leagueSlug"
                    className="input"
                    type="text"
                    required
                    placeholder="e.g. the-boys"
                    value={leagueSlug}
                    onChange={e => setLeagueSlug(e.target.value)}
                    aria-invalid={!!fieldErrors.leagueSlug}
                  />
                  {fieldErrors.leagueSlug ? (
                    <p className="hint" style={{ color: 'var(--red)' }}>{fieldErrors.leagueSlug}</p>
                  ) : (
                    <p className="hint" style={{ color: 'var(--slate-mid)', fontSize: '0.78rem' }}>
                      From your commissioner&rsquo;s invite link: the part after <code>/join/</code>.
                    </p>
                  )}
                </div>

                <div className="field">
                  <label className="label" htmlFor="inviteCode">Invite Code</label>
                  <input
                    id="inviteCode"
                    className="input"
                    type="text"
                    required
                    placeholder="e.g. ABC123"
                    value={inviteCode}
                    onChange={e => setInviteCode(e.target.value)}
                    aria-invalid={!!fieldErrors.inviteCode}
                  />
                  {fieldErrors.inviteCode ? (
                    <p className="hint" style={{ color: 'var(--red)' }}>{fieldErrors.inviteCode}</p>
                  ) : (
                    <p className="hint" style={{ color: 'var(--slate-mid)', fontSize: '0.78rem' }}>
                      Signup is invite-only. Ask a commissioner to share their link.
                    </p>
                  )}
                </div>
              </>
            )}

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
                placeholder={`Min. ${AUTH_LIMITS.PASSWORD_MIN} chars, mix of classes`}
                minLength={AUTH_LIMITS.PASSWORD_MIN}
                maxLength={AUTH_LIMITS.PASSWORD_MAX}
                value={password}
                onChange={e => setPassword(e.target.value)}
                aria-invalid={!!fieldErrors.password}
              />
              {fieldErrors.password ? (
                <p className="hint" style={{ color: 'var(--red)' }}>{fieldErrors.password}</p>
              ) : (
                <p className="hint" style={{ color: 'var(--slate-mid)', fontSize: '0.78rem' }}>
                  {AUTH_LIMITS.PASSWORD_MIN}+ characters with at least {AUTH_LIMITS.PASSWORD_MIN_CLASSES} of:
                  lowercase, uppercase, digit, symbol.
                </p>
              )}
            </div>

            <button type="submit" className="btn btn-primary btn-full btn-lg" disabled={loading} aria-busy={loading} style={{ marginTop: '0.5rem' }}>
              {loading ? 'Creating account…' : 'Create Account →'}
            </button>
          </form>
        </div>
        )}

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
