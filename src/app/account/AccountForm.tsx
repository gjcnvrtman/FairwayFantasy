'use client';

// ─────────────────────────────────────────────────────────────
// Account form — four independently-submittable cards on one
// page so a user can change one thing without having to re-enter
// the others:
//
//   1. Display Name         → PUT  /api/me/profile
//   2. Change Password      → POST /api/me/change-password
//   3. Email Recaps         → PUT  /api/me/notification-prefs
//   4. Pick Reminders       → PUT  /api/me/notification-prefs
//
// Cards 3 + 4 both write to the same row in reminder_preferences,
// so each card sends the FULL prefs payload (its toggles + the
// other card's current state held in local React state) to avoid
// clobbering the other card's settings.
// ─────────────────────────────────────────────────────────────

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface Prefs {
  user_id:                    string;
  email_enabled:              boolean;
  sms_enabled?:               boolean;
  push_enabled?:              boolean;
  nightly_recap_enabled:      boolean;
  tournament_recap_enabled:   boolean;
  field_published_enabled:    boolean;
  hours_before:               number;
  email_addr:                 string | null;
}

interface Props {
  initialPrefs: Prefs;
  profileEmail: string;
  profileDisplayName: string;
  profileFirstName: string;
  profileLastName:  string;
  isPlatformAdmin:  boolean;
}

export default function AccountForm({
  initialPrefs, profileEmail, profileDisplayName,
  profileFirstName, profileLastName, isPlatformAdmin,
}: Props) {
  // Single source of truth for the prefs row — both Recaps and
  // Reminders cards read + mutate this, and both send a full
  // payload on save so they don't clobber each other.
  const [prefs, setPrefs] = useState<Prefs>(initialPrefs);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <DisplayNameCard initialName={profileDisplayName} />
      <FullNameCard initialFirst={profileFirstName} initialLast={profileLastName} />
      <ChangePasswordCard />
      <RecapsCard
        prefs={prefs}
        onPrefsChange={setPrefs}
      />
      <RemindersCard
        prefs={prefs}
        onPrefsChange={setPrefs}
        profileEmail={profileEmail}
        isPlatformAdmin={isPlatformAdmin}
      />
      <div>
        <Link href="/dashboard" className="btn btn-ghost">Back to dashboard</Link>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Display Name — shown on the leaderboard, history, stats,
// schedule, and nav. Writing here propagates to every surface.
// ─────────────────────────────────────────────────────────────

function DisplayNameCard({ initialName }: { initialName: string }) {
  const router = useRouter();
  const [name,    setName]    = useState(initialName);
  const [saving,  setSaving]  = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [errors,  setErrors]  = useState<Record<string, string>>({});
  const [topErr,  setTopErr]  = useState('');

  const trimmed = name.trim();
  const unchanged = trimmed === initialName.trim();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setSavedAt(null); setErrors({}); setTopErr('');

    try {
      const res = await fetch('/api/me/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.fieldErrors) setErrors(data.fieldErrors);
        else setTopErr(data.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      setSavedAt(new Date());
      // The Nav reads display_name from a server component, and every
      // league surface (leaderboard, history, stats) snapshots it at
      // request time. Refresh so all of them pick up the new name
      // without a manual reload.
      router.refresh();
    } catch (err) {
      setTopErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <h2 style={{
        fontFamily: "'Playfair Display', serif",
        fontSize: '1.3rem', fontWeight: 700, marginBottom: '0.2rem',
      }}>
        Display Name
      </h2>
      <p style={{ color: 'var(--slate-mid)', fontSize: '0.9rem', lineHeight: 1.5 }}>
        This is what shows next to your picks on the leaderboard, history,
        and stats. Change it any time — your account and league memberships
        stay the same.
      </p>

      {topErr && (
        <div className="alert alert-error" role="alert">{topErr}</div>
      )}
      {savedAt && (
        <div className="alert alert-success" role="status">
          ✓ Display name updated at {savedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.
        </div>
      )}

      <div>
        <label className="label" htmlFor="display_name">Display name</label>
        <input
          id="display_name"
          className="input"
          type="text"
          autoComplete="nickname"
          maxLength={40}
          value={name}
          onChange={e => setName(e.target.value)}
          aria-invalid={!!errors.display_name}
        />
        {errors.display_name && <p className="hint" style={{ color: 'var(--red)' }}>{errors.display_name}</p>}
      </div>

      <div>
        <button type="submit" className="btn btn-primary" disabled={saving || unchanged} aria-busy={saving}>
          {saving ? 'Saving…' : 'Save display name'}
        </button>
      </div>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────
// Full Name — first + last, optional. Added 2026-06-12 alongside
// the leaderboard real-name label change. Saved values surface on
// the leaderboard as "(First Last · email)" when both fields are
// non-empty.
// ─────────────────────────────────────────────────────────────

function FullNameCard({
  initialFirst, initialLast,
}: {
  initialFirst: string;
  initialLast:  string;
}) {
  const router = useRouter();
  const [first,   setFirst]   = useState(initialFirst);
  const [last,    setLast]    = useState(initialLast);
  const [saving,  setSaving]  = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [errors,  setErrors]  = useState<Record<string, string>>({});
  const [topErr,  setTopErr]  = useState('');

  const trimmedFirst = first.trim();
  const trimmedLast  = last.trim();
  const unchanged =
    trimmedFirst === initialFirst.trim() &&
    trimmedLast  === initialLast.trim();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setSavedAt(null); setErrors({}); setTopErr('');

    try {
      const res = await fetch('/api/me/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ first_name: trimmedFirst, last_name: trimmedLast }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.fieldErrors) setErrors(data.fieldErrors);
        else setTopErr(data.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      setSavedAt(new Date());
      router.refresh();
    } catch (err) {
      setTopErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <h2 style={{
        fontFamily: "'Playfair Display', serif",
        fontSize: '1.3rem', fontWeight: 700, marginBottom: '0.2rem',
      }}>
        Full Name
      </h2>
      <p style={{ color: 'var(--slate-mid)', fontSize: '0.9rem', lineHeight: 1.5 }}>
        Your real name. Shown in parentheses on the leaderboard after your
        display name so league members know who&rsquo;s who. Leave blank if
        you&rsquo;d rather only show your display name + email.
      </p>

      {topErr && (
        <div className="alert alert-error" role="alert">{topErr}</div>
      )}
      {savedAt && (
        <div className="alert alert-success" role="status">
          ✓ Name updated at {savedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
        <div>
          <label className="label" htmlFor="first_name">First name</label>
          <input
            id="first_name"
            className="input"
            type="text"
            autoComplete="given-name"
            maxLength={60}
            value={first}
            onChange={e => setFirst(e.target.value)}
            aria-invalid={!!errors.first_name}
          />
          {errors.first_name && <p className="hint" style={{ color: 'var(--red)' }}>{errors.first_name}</p>}
        </div>
        <div>
          <label className="label" htmlFor="last_name">Last name</label>
          <input
            id="last_name"
            className="input"
            type="text"
            autoComplete="family-name"
            maxLength={60}
            value={last}
            onChange={e => setLast(e.target.value)}
            aria-invalid={!!errors.last_name}
          />
          {errors.last_name && <p className="hint" style={{ color: 'var(--red)' }}>{errors.last_name}</p>}
        </div>
      </div>

      <div>
        <button type="submit" className="btn btn-primary" disabled={saving || unchanged} aria-busy={saving}>
          {saving ? 'Saving…' : 'Save name'}
        </button>
      </div>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────
// Change Password
// ─────────────────────────────────────────────────────────────

function ChangePasswordCard() {
  const [current, setCurrent]   = useState('');
  const [next,    setNext]      = useState('');
  const [confirm, setConfirm]   = useState('');
  const [saving,  setSaving]    = useState(false);
  const [savedAt, setSavedAt]   = useState<Date | null>(null);
  const [errors,  setErrors]    = useState<Record<string, string>>({});
  const [topErr,  setTopErr]    = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setSavedAt(null); setErrors({}); setTopErr('');

    // Mismatch check is client-side only — server doesn't need a
    // confirm field, it just trusts the new_password value.
    if (next !== confirm) {
      setErrors({ confirm_password: 'New password and confirmation do not match.' });
      setSaving(false);
      return;
    }

    try {
      const res = await fetch('/api/me/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.fieldErrors) setErrors(data.fieldErrors);
        else setTopErr(data.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      setSavedAt(new Date());
      setCurrent(''); setNext(''); setConfirm('');
    } catch (err) {
      setTopErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <h2 style={{
        fontFamily: "'Playfair Display', serif",
        fontSize: '1.3rem', fontWeight: 700, marginBottom: '0.2rem',
      }}>
        Change Password
      </h2>
      <p style={{ color: 'var(--slate-mid)', fontSize: '0.9rem', lineHeight: 1.5 }}>
        You&rsquo;ll need your current password. The new password must be at least 8 characters
        and include a letter and a number.
      </p>

      {topErr && (
        <div className="alert alert-error" role="alert">{topErr}</div>
      )}
      {savedAt && (
        <div className="alert alert-success" role="status">
          ✓ Password updated at {savedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.
        </div>
      )}

      <div>
        <label className="label" htmlFor="cp_current">Current password</label>
        <input
          id="cp_current"
          className="input"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={e => setCurrent(e.target.value)}
          aria-invalid={!!errors.current_password}
        />
        {errors.current_password && <p className="hint" style={{ color: 'var(--red)' }}>{errors.current_password}</p>}
      </div>

      <div>
        <label className="label" htmlFor="cp_new">New password</label>
        <input
          id="cp_new"
          className="input"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={e => setNext(e.target.value)}
          aria-invalid={!!errors.new_password}
        />
        {errors.new_password && <p className="hint" style={{ color: 'var(--red)' }}>{errors.new_password}</p>}
      </div>

      <div>
        <label className="label" htmlFor="cp_confirm">Confirm new password</label>
        <input
          id="cp_confirm"
          className="input"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          aria-invalid={!!errors.confirm_password}
        />
        {errors.confirm_password && <p className="hint" style={{ color: 'var(--red)' }}>{errors.confirm_password}</p>}
      </div>

      <div>
        <button type="submit" className="btn btn-primary" disabled={saving} aria-busy={saving}>
          {saving ? 'Saving…' : 'Update password'}
        </button>
      </div>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────
// Email Recaps  (nightly scorecard + final tournament recap)
// ─────────────────────────────────────────────────────────────

function RecapsCard({
  prefs, onPrefsChange,
}: {
  prefs: Prefs;
  onPrefsChange: (p: Prefs) => void;
}) {
  const [saving,  setSaving]  = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [topErr,  setTopErr]  = useState('');

  async function save(updates: Partial<Prefs>) {
    const merged = { ...prefs, ...updates };
    onPrefsChange(merged);
    setSaving(true); setSavedAt(null); setTopErr('');
    try {
      const res = await fetch('/api/me/notification-prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email_enabled:             merged.email_enabled,
          nightly_recap_enabled:     merged.nightly_recap_enabled,
          tournament_recap_enabled:  merged.tournament_recap_enabled,
          field_published_enabled:   merged.field_published_enabled,
          hours_before:              merged.hours_before,
          email_addr:                merged.email_addr,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setTopErr(data.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      setSavedAt(new Date());
    } catch (err) {
      setTopErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{
        fontFamily: "'Playfair Display', serif",
        fontSize: '1.3rem', fontWeight: 700, marginBottom: '0.2rem',
      }}>
        Email Recaps
      </h2>
      <p style={{ color: 'var(--slate-mid)', fontSize: '0.9rem', lineHeight: 1.5 }}>
        After each round ends we send a daily scorecard with the league standings and a PDF
        of your foursome. After a tournament wraps, we send a final recap with the result
        and your best round. Toggle either off if you&rsquo;d rather not get them.
      </p>

      {topErr && (
        <div className="alert alert-error" style={{ marginTop: '0.75rem' }} role="alert">{topErr}</div>
      )}
      {savedAt && (
        <div className="alert alert-success" style={{ marginTop: '0.75rem' }} role="status">
          ✓ Saved at {savedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.
        </div>
      )}

      <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <ToggleRow
          label="Nightly scorecard recap"
          helper="One email per round you played — leaderboard + your foursome + a PDF scorecard."
          checked={prefs.nightly_recap_enabled}
          disabled={saving}
          onChange={v => save({ nightly_recap_enabled: v })}
        />
        <ToggleRow
          label="Final tournament recap"
          helper="One email per tournament when it wraps — final league standings + your best round."
          checked={prefs.tournament_recap_enabled}
          disabled={saving}
          onChange={v => save({ tournament_recap_enabled: v })}
        />
        <ToggleRow
          label="Field set alert"
          helper="One email when ESPN publishes the field for an upcoming tournament — so you know picks are unlocked."
          checked={prefs.field_published_enabled}
          disabled={saving}
          onChange={v => save({ field_published_enabled: v })}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Pick Reminders  (the existing email_enabled / hours_before / addr)
// ─────────────────────────────────────────────────────────────

function RemindersCard({
  prefs, onPrefsChange, profileEmail, isPlatformAdmin,
}: {
  prefs: Prefs;
  onPrefsChange: (p: Prefs) => void;
  profileEmail: string;
  isPlatformAdmin: boolean;
}) {
  const [emailAddr,  setEmailAddr]   = useState(prefs.email_addr ?? '');
  const [hoursBefore, setHoursBefore] = useState(prefs.hours_before);
  const [saving,     setSaving]      = useState(false);
  const [savedAt,    setSavedAt]     = useState<Date | null>(null);
  const [errors,     setErrors]      = useState<Record<string, string>>({});
  const [topErr,     setTopErr]      = useState('');

  async function save(updates: Partial<Prefs>) {
    // For the on/off switch we send immediately. For the form fields
    // (hours, addr) we send on explicit "Save" click via handleSubmit.
    const merged = {
      ...prefs,
      ...updates,
      hours_before: updates.hours_before ?? hoursBefore,
      email_addr:   updates.email_addr   ?? (emailAddr.trim() || null),
    };
    onPrefsChange(merged);
    setSaving(true); setSavedAt(null); setErrors({}); setTopErr('');
    try {
      const res = await fetch('/api/me/notification-prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email_enabled:             merged.email_enabled,
          nightly_recap_enabled:     merged.nightly_recap_enabled,
          tournament_recap_enabled:  merged.tournament_recap_enabled,
          field_published_enabled:   merged.field_published_enabled,
          hours_before:              merged.hours_before,
          email_addr:                merged.email_addr,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.fieldErrors) setErrors(data.fieldErrors);
        else setTopErr(data.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      setSavedAt(new Date());
    } catch (err) {
      setTopErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await save({ hours_before: hoursBefore, email_addr: emailAddr.trim() || null });
  }

  return (
    <form onSubmit={handleSubmit} className="card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <h2 style={{
        fontFamily: "'Playfair Display', serif",
        fontSize: '1.3rem', fontWeight: 700, marginBottom: '0.2rem',
      }}>
        Pick Reminders
      </h2>
      <p style={{ color: 'var(--slate-mid)', fontSize: '0.9rem', lineHeight: 1.5 }}>
        We&rsquo;ll nudge you when picks are about to lock so you don&rsquo;t miss a tournament.
      </p>

      {topErr && (
        <div className="alert alert-error" role="alert">{topErr}</div>
      )}
      {savedAt && (
        <div className="alert alert-success" role="status">
          ✓ Saved at {savedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.
        </div>
      )}

      <ToggleRow
        label="Email pick reminders"
        helper={(isPlatformAdmin && emailAddr.trim()) || profileEmail || 'No email on file'}
        checked={prefs.email_enabled}
        disabled={saving}
        onChange={v => save({ email_enabled: v })}
      />

      {prefs.email_enabled && (
        <>
          {isPlatformAdmin && (
            <div>
              <label className="label" htmlFor="email_addr">Override email (optional)</label>
              <input
                id="email_addr"
                className="input"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder={profileEmail ? `Defaults to ${profileEmail}` : 'you@example.com'}
                value={emailAddr}
                onChange={e => setEmailAddr(e.target.value)}
              />
              <p className="hint">
                Leave blank to use your account email.
              </p>
            </div>
          )}

          <div>
            <label className="label" htmlFor="hours_before">
              Send the reminder this many hours before pick deadline
            </label>
            <input
              id="hours_before"
              className="input"
              type="number"
              min={1}
              max={168}
              step={1}
              value={hoursBefore}
              onChange={e => setHoursBefore(Number(e.target.value))}
              aria-invalid={!!errors.hours_before}
              style={{ maxWidth: 160 }}
            />
            {errors.hours_before && <p className="hint" style={{ color: 'var(--red)' }}>{errors.hours_before}</p>}
            <p className="hint">
              Common values: <strong>2</strong> (couple hours notice),
              <strong> 24</strong> (next day),
              <strong> 48</strong> (two days).
            </p>
          </div>

          <div>
            <button type="submit" className="btn btn-primary" disabled={saving} aria-busy={saving}>
              {saving ? 'Saving…' : 'Save reminder timing'}
            </button>
          </div>
        </>
      )}
    </form>
  );
}

// ─────────────────────────────────────────────────────────────
// Toggle row — flat switch + helper text, save fires immediately.
// ─────────────────────────────────────────────────────────────

function ToggleRow({
  label, helper, checked, disabled, onChange,
}: {
  label:    string;
  helper:   string;
  checked:  boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '0.75rem', padding: '0.6rem 0',
      borderBottom: '1px solid var(--cream-dark)',
    }}>
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{label}</div>
        <div style={{ color: 'var(--slate-mid)', fontSize: '0.82rem' }}>{helper}</div>
      </div>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', cursor: disabled ? 'wait' : 'pointer' }}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={e => onChange(e.target.checked)}
          aria-label={label}
          style={{ width: 20, height: 20, accentColor: 'var(--green-mid)' }}
        />
        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: checked ? 'var(--green-mid)' : 'var(--slate-mid)' }}>
          {checked ? 'On' : 'Off'}
        </span>
      </label>
    </div>
  );
}
