'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  validateCreateLeague,
  deriveSlugFromName,
  LEAGUE_LIMITS,
  type FieldErrors,
} from '@/lib/validation';

interface CreatedLeague {
  id:        string;
  name:      string;
  slug:      string;
  inviteUrl: string;
}

// Default tournament window: today → end of the current calendar year.
// Both yyyy-mm-dd to match the <input type="date"> contract. We do
// this on the client only (no SSR — page is 'use client').
function defaultDateRange(): { start: string; end: string } {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const dd   = String(now.getDate()).padStart(2, '0');
  return { start: `${yyyy}-${mm}-${dd}`, end: `${yyyy}-12-31` };
}

export default function CreateLeaguePage() {
  // ── form state ─────────────────────────────────────────────
  const defaults                      = defaultDateRange();
  const [name, setName]               = useState('');
  const [slug, setSlug]               = useState('');
  const [slugEdited, setSlugEdited]   = useState(false);
  const [maxPlayers, setMaxPlayers]   = useState<number>(LEAGUE_LIMITS.MAX_PLAYERS_DEFAULT);
  const [startDate, setStartDate]     = useState<string>(defaults.start);
  const [endDate, setEndDate]         = useState<string>(defaults.end);
  const [weeklyBetAmount, setWeeklyBetAmount] = useState<number>(LEAGUE_LIMITS.BET_DEFAULT);

  const [touched, setTouched]         = useState<Set<keyof FieldErrors>>(new Set());
  const [submitting, setSubmitting]   = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [generalError, setGeneralError] = useState<string>('');

  // ── post-create state — replaces the form on success ───────
  const [created, setCreated]   = useState<CreatedLeague | null>(null);
  const [copied, setCopied]     = useState(false);

  // Compose absolute invite URL from origin so users can copy + paste.
  const inviteAbsolute = useMemo(() => {
    if (!created) return '';
    if (typeof window === 'undefined') return created.inviteUrl;
    return `${window.location.origin}${created.inviteUrl}`;
  }, [created]);

  // ── live client-side validation (same fn as server) ────────
  const clientErrors = useMemo(
    () => validateCreateLeague({
      name, slug, maxPlayers, startDate, endDate, weeklyBetAmount,
    }),
    [name, slug, maxPlayers, startDate, endDate, weeklyBetAmount]
  );

  // Merge server errors over client errors so a server-side rejection
  // (e.g. slug already taken) wins until the user edits that field.
  const errors: FieldErrors = { ...clientErrors, ...serverErrors };

  // Show field error only after user has interacted with that field —
  // less noisy on first paint.
  function shouldShow(field: keyof FieldErrors): boolean {
    return touched.has(field) || !!serverErrors[field];
  }

  function markTouched(field: keyof FieldErrors) {
    if (!touched.has(field)) {
      setTouched(prev => {
        const next = new Set(prev);
        next.add(field);
        return next;
      });
    }
  }

  // ── handlers ───────────────────────────────────────────────
  function onNameChange(v: string) {
    setName(v);
    if (!slugEdited) setSlug(deriveSlugFromName(v));
    if (serverErrors.name) setServerErrors(({ name: _n, ...rest }) => rest);
  }

  function onSlugChange(v: string) {
    // Allow free typing but normalize to slug-safe chars.
    const cleaned = v.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, LEAGUE_LIMITS.SLUG_MAX);
    setSlug(cleaned);
    setSlugEdited(true);
    if (serverErrors.slug) setServerErrors(({ slug: _s, ...rest }) => rest);
  }

  function onMaxPlayersChange(v: string) {
    const n = parseInt(v, 10);
    setMaxPlayers(Number.isFinite(n) ? n : NaN);
    if (serverErrors.maxPlayers) setServerErrors(({ maxPlayers: _m, ...rest }) => rest);
  }

  function onStartDateChange(v: string) {
    setStartDate(v);
    if (serverErrors.startDate) setServerErrors(({ startDate: _s, ...rest }) => rest);
  }
  function onEndDateChange(v: string) {
    setEndDate(v);
    if (serverErrors.endDate) setServerErrors(({ endDate: _e, ...rest }) => rest);
  }
  function onWeeklyBetAmountChange(v: string) {
    // parseFloat tolerates partial typing like "10" or "10." mid-edit;
    // server validator does the strict 2-decimal check.
    const n = parseFloat(v);
    setWeeklyBetAmount(Number.isFinite(n) ? n : NaN);
    if (serverErrors.weeklyBetAmount) setServerErrors(({ weeklyBetAmount: _w, ...rest }) => rest);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerErrors({}); setGeneralError('');

    // mark all fields touched so any latent client errors show
    setTouched(new Set([
      'name', 'slug', 'maxPlayers', 'startDate', 'endDate', 'weeklyBetAmount',
    ]));

    if (Object.keys(clientErrors).length > 0) {
      // Don't even submit — surface client errors first.
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/leagues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(), slug: slug.trim(), maxPlayers,
          startDate, endDate, weeklyBetAmount,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (data.fieldErrors) {
          setServerErrors(data.fieldErrors);
        } else {
          setGeneralError(data.error ?? 'Something went wrong creating your league.');
        }
        return;
      }
      setCreated({
        id:        data.league?.id ?? '',
        name:      data.league?.name ?? name,
        slug:      data.league?.slug ?? slug,
        inviteUrl: data.inviteUrl ?? `/join/${slug}/${data.league?.invite_code ?? ''}`,
      });
    } catch (err) {
      setGeneralError(`Network error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function copyInvite() {
    if (!inviteAbsolute) return;
    try {
      await navigator.clipboard.writeText(inviteAbsolute);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  // Reset the "copied" toast after 2 seconds.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  function startOver() {
    const d = defaultDateRange();
    setName(''); setSlug(''); setSlugEdited(false);
    setMaxPlayers(LEAGUE_LIMITS.MAX_PLAYERS_DEFAULT);
    setStartDate(d.start); setEndDate(d.end);
    setWeeklyBetAmount(LEAGUE_LIMITS.BET_DEFAULT);
    setTouched(new Set());
    setServerErrors({}); setGeneralError('');
    setCreated(null); setCopied(false);
  }

  // ── render ─────────────────────────────────────────────────
  if (created) {
    return <SuccessPanel created={created} inviteAbsolute={inviteAbsolute}
                         copied={copied} onCopy={copyInvite} onStartOver={startOver} />;
  }

  const submitDisabled = submitting || Object.keys(clientErrors).length > 0;

  return (
    <div className="page-shell" style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0 }}>
        <nav className="nav">
          <div className="nav-inner">
            <Link href="/dashboard" className="nav-logo">Fairway <span>Fantasy</span></Link>
            <div className="nav-actions">
              <Link href="/dashboard" className="btn btn-ghost btn-sm" style={{ color: 'rgba(255,255,255,0.6)' }}>
                ← My Leagues
              </Link>
            </div>
          </div>
        </nav>
      </div>

      <div className="container-sm" style={{ paddingTop: '6rem', paddingBottom: '3rem' }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>🏆</div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 'clamp(1.6rem,5vw,2rem)',
                       fontWeight: 900, marginBottom: '0.4rem' }}>
            Create a League
          </h1>
          <p style={{ color: 'var(--slate-mid)', fontSize: '0.95rem' }}>
            Name it. Pick a URL. Set the size. You&rsquo;re the commissioner.
          </p>
        </div>

        <div className="card">
          <form onSubmit={handleSubmit} noValidate>
            {generalError && <div className="alert alert-error">{generalError}</div>}

            {/* ── Name ─────────────────────────────────── */}
            <div className="field">
              <label className="label" htmlFor="league-name">League Name</label>
              <input
                id="league-name"
                className={`input ${shouldShow('name') && errors.name ? 'input-error' : ''}`}
                type="text"
                placeholder="The Boys Golf Club"
                value={name}
                onChange={e => onNameChange(e.target.value)}
                onBlur={() => markTouched('name')}
                maxLength={LEAGUE_LIMITS.NAME_MAX}
                aria-invalid={!!(shouldShow('name') && errors.name)}
                aria-describedby={shouldShow('name') && errors.name ? 'league-name-error' : 'league-name-hint'}
              />
              {shouldShow('name') && errors.name ? (
                <p id="league-name-error" className="hint" style={{ color: 'var(--red)' }}>
                  {errors.name}
                </p>
              ) : (
                <p id="league-name-hint" className="hint">
                  {LEAGUE_LIMITS.NAME_MIN}&ndash;{LEAGUE_LIMITS.NAME_MAX} characters.
                  This shows up at the top of every leaderboard.
                </p>
              )}
            </div>

            {/* ── Slug ─────────────────────────────────── */}
            <div className="field">
              <label className="label" htmlFor="league-slug">League URL</label>
              <div style={{
                display: 'flex', alignItems: 'stretch',
                border: shouldShow('slug') && errors.slug
                          ? '2px solid var(--red)'
                          : '2px solid var(--cream-dark)',
                borderRadius: 'var(--radius)',
                overflow: 'hidden', background: 'white',
                transition: 'border-color 0.15s',
              }}>
                <span style={{
                  padding: '0.75rem 0.9rem',
                  color: 'var(--slate-mid)',
                  fontSize: '0.82rem',
                  background: 'var(--cream)',
                  borderRight: '1px solid var(--cream-dark)',
                  whiteSpace: 'nowrap',
                  display: 'flex', alignItems: 'center',
                }}>
                  /league/
                </span>
                <input
                  id="league-slug"
                  style={{
                    flex: 1, minWidth: 0,
                    padding: '0.75rem 0.9rem', border: 'none', outline: 'none',
                    fontFamily: 'inherit', fontSize: '0.95rem', fontWeight: 600,
                    background: 'transparent', color: 'var(--green-deep)',
                  }}
                  type="text"
                  placeholder="the-boys"
                  value={slug}
                  onChange={e => onSlugChange(e.target.value)}
                  onBlur={() => markTouched('slug')}
                  aria-invalid={!!(shouldShow('slug') && errors.slug)}
                  aria-describedby={shouldShow('slug') && errors.slug ? 'league-slug-error' : 'league-slug-hint'}
                />
              </div>
              {shouldShow('slug') && errors.slug ? (
                <p id="league-slug-error" className="hint" style={{ color: 'var(--red)' }}>
                  {errors.slug}
                </p>
              ) : (
                <p id="league-slug-hint" className="hint">
                  Lowercase letters, numbers, and hyphens. Auto-suggested from your name; tap to customize.
                </p>
              )}
            </div>

            {/* ── Max players ──────────────────────────── */}
            <div className="field">
              <label className="label" htmlFor="league-max">Max Players</label>
              <input
                id="league-max"
                className={`input ${shouldShow('maxPlayers') && errors.maxPlayers ? 'input-error' : ''}`}
                type="number"
                min={LEAGUE_LIMITS.MAX_PLAYERS_MIN}
                max={LEAGUE_LIMITS.MAX_PLAYERS_MAX}
                step={1}
                inputMode="numeric"
                value={Number.isFinite(maxPlayers) ? maxPlayers : ''}
                onChange={e => onMaxPlayersChange(e.target.value)}
                onBlur={() => markTouched('maxPlayers')}
                aria-invalid={!!(shouldShow('maxPlayers') && errors.maxPlayers)}
                aria-describedby={shouldShow('maxPlayers') && errors.maxPlayers ? 'league-max-error' : 'league-max-hint'}
              />
              {shouldShow('maxPlayers') && errors.maxPlayers ? (
                <p id="league-max-error" className="hint" style={{ color: 'var(--red)' }}>
                  {errors.maxPlayers}
                </p>
              ) : (
                <p id="league-max-hint" className="hint">
                  Cap on roster size ({LEAGUE_LIMITS.MAX_PLAYERS_MIN}&ndash;{LEAGUE_LIMITS.MAX_PLAYERS_MAX}).
                  Default is {LEAGUE_LIMITS.MAX_PLAYERS_DEFAULT}. You can&rsquo;t change this later from the UI yet.
                </p>
              )}
            </div>

            {/* ── Tournament window (start + end) ────────── */}
            <div className="field">
              <label className="label">Tournament Window</label>
              <p className="hint" style={{ marginTop: 0, marginBottom: '0.5rem' }}>
                Only tournaments starting inside this date range will count toward this league.
              </p>
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 180px' }}>
                  <label htmlFor="league-start" className="hint" style={{ display: 'block', fontWeight: 600, color: 'var(--slate)', marginBottom: '0.25rem' }}>
                    Start
                  </label>
                  <input
                    id="league-start"
                    className={`input ${shouldShow('startDate') && errors.startDate ? 'input-error' : ''}`}
                    type="date"
                    value={startDate}
                    onChange={e => onStartDateChange(e.target.value)}
                    onBlur={() => markTouched('startDate')}
                    aria-invalid={!!(shouldShow('startDate') && errors.startDate)}
                  />
                </div>
                <div style={{ flex: '1 1 180px' }}>
                  <label htmlFor="league-end" className="hint" style={{ display: 'block', fontWeight: 600, color: 'var(--slate)', marginBottom: '0.25rem' }}>
                    End
                  </label>
                  <input
                    id="league-end"
                    className={`input ${shouldShow('endDate') && errors.endDate ? 'input-error' : ''}`}
                    type="date"
                    value={endDate}
                    min={startDate || undefined}
                    onChange={e => onEndDateChange(e.target.value)}
                    onBlur={() => markTouched('endDate')}
                    aria-invalid={!!(shouldShow('endDate') && errors.endDate)}
                  />
                </div>
              </div>
              {(shouldShow('startDate') && errors.startDate) && (
                <p className="hint" style={{ color: 'var(--red)' }}>{errors.startDate}</p>
              )}
              {(shouldShow('endDate') && errors.endDate) && (
                <p className="hint" style={{ color: 'var(--red)' }}>{errors.endDate}</p>
              )}
            </div>

            {/* ── Weekly bet amount ──────────────────────── */}
            <div className="field">
              <label className="label" htmlFor="league-bet">Weekly Bet Amount</label>
              <div style={{
                display: 'flex', alignItems: 'stretch',
                border: shouldShow('weeklyBetAmount') && errors.weeklyBetAmount
                          ? '2px solid var(--red)'
                          : '2px solid var(--cream-dark)',
                borderRadius: 'var(--radius)',
                overflow: 'hidden', background: 'white',
              }}>
                <span style={{
                  padding: '0.75rem 0.9rem',
                  color: 'var(--slate-mid)', fontWeight: 600,
                  background: 'var(--cream)',
                  borderRight: '1px solid var(--cream-dark)',
                  display: 'flex', alignItems: 'center',
                }}>$</span>
                <input
                  id="league-bet"
                  type="number"
                  min={LEAGUE_LIMITS.BET_MIN}
                  max={LEAGUE_LIMITS.BET_MAX}
                  step="0.01"
                  inputMode="decimal"
                  value={Number.isFinite(weeklyBetAmount) ? weeklyBetAmount : ''}
                  onChange={e => onWeeklyBetAmountChange(e.target.value)}
                  onBlur={() => markTouched('weeklyBetAmount')}
                  aria-invalid={!!(shouldShow('weeklyBetAmount') && errors.weeklyBetAmount)}
                  style={{
                    flex: 1, minWidth: 0,
                    padding: '0.75rem 0.9rem', border: 'none', outline: 'none',
                    fontFamily: 'inherit', fontSize: '0.95rem', fontWeight: 600,
                    background: 'transparent', color: 'var(--green-deep)',
                  }}
                />
              </div>
              {shouldShow('weeklyBetAmount') && errors.weeklyBetAmount ? (
                <p className="hint" style={{ color: 'var(--red)' }}>{errors.weeklyBetAmount}</p>
              ) : (
                <p className="hint">
                  After each completed tournament, every non-winner owes the winner this amount.
                  Ties at #1 split the pot evenly. Default ${LEAGUE_LIMITS.BET_DEFAULT}.
                </p>
              )}
            </div>

            <div className="alert alert-info" style={{ marginTop: '0.5rem' }}>
              💡 After creating, you&rsquo;ll get an invite link to share with your group.
            </div>

            <button
              type="submit"
              className="btn btn-primary btn-full btn-lg"
              disabled={submitDisabled}
              style={{ marginTop: '1rem' }}
            >
              {submitting ? 'Creating…' : 'Create League →'}
            </button>
          </form>
        </div>

        <p style={{ textAlign: 'center', color: 'var(--slate-mid)',
                    fontSize: '0.875rem', marginTop: '1.25rem' }}>
          <Link href="/dashboard" style={{ color: 'var(--green-mid)',
                                            fontWeight: 600, textDecoration: 'none' }}>
            ← Back to dashboard
          </Link>
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Success state — shown after a successful POST. The user picks
// when to navigate away (replaces the previous immediate redirect).
// ─────────────────────────────────────────────────────────────
function SuccessPanel({ created, inviteAbsolute, copied, onCopy, onStartOver }: {
  created: CreatedLeague;
  inviteAbsolute: string;
  copied: boolean;
  onCopy: () => void;
  onStartOver: () => void;
}) {
  return (
    <div className="page-shell" style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0 }}>
        <nav className="nav">
          <div className="nav-inner">
            <Link href="/dashboard" className="nav-logo">Fairway <span>Fantasy</span></Link>
          </div>
        </nav>
      </div>

      <div className="container-sm" style={{ paddingTop: '6rem', paddingBottom: '3rem' }}>
        <div style={{ textAlign: 'center', marginBottom: '1.75rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>🎉</div>
          <h1 style={{ fontFamily: "'Playfair Display', serif",
                       fontSize: 'clamp(1.7rem,5vw,2.2rem)',
                       fontWeight: 900, marginBottom: '0.4rem' }}>
            Created!
          </h1>
          <p style={{ color: 'var(--slate-mid)', fontSize: '0.95rem' }}>
            <strong style={{ color: 'var(--green-deep)' }}>{created.name}</strong> is live.
            Share the invite link to bring your group in.
          </p>
        </div>

        <div className="card" style={{ borderLeft: '4px solid var(--brass)' }}>
          <p className="label" style={{ marginBottom: '0.5rem' }}>Invite link</p>
          <div style={{
            background: 'var(--cream)', border: '1px solid var(--cream-dark)',
            borderRadius: 'var(--radius-sm)', padding: '0.75rem 1rem',
            fontFamily: 'monospace', fontSize: '0.85rem', wordBreak: 'break-all',
            color: 'var(--green-deep)', marginBottom: '0.85rem',
          }}>
            {inviteAbsolute || created.inviteUrl}
          </div>
          <button className="btn btn-primary btn-full" onClick={onCopy}>
            {copied ? '✓ Copied' : '📋 Copy invite link'}
          </button>
          <p className="hint" style={{ marginTop: '0.6rem' }}>
            Anyone who opens this link can sign up and join your league. Send it via text, email, group chat — whatever works.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '1.25rem' }}>
          <Link href={`/league/${created.slug}`}
                className="btn btn-brass btn-lg" style={{ flex: '1 1 240px' }}>
            Go to League Dashboard →
          </Link>
          <button onClick={onStartOver} className="btn btn-outline btn-lg" style={{ flex: '1 1 180px' }}>
            Create Another
          </button>
        </div>

        <p style={{ textAlign: 'center', color: 'var(--slate-mid)',
                    fontSize: '0.85rem', marginTop: '1.5rem' }}>
          Need to regenerate the invite later? You can do that from{' '}
          <Link href={`/league/${created.slug}/admin`} style={{ color: 'var(--green-mid)', fontWeight: 600 }}>
            Commissioner Admin
          </Link>.
        </p>
      </div>
    </div>
  );
}
