'use client';

// ─────────────────────────────────────────────────────────────
// Notification preferences form.
//
// 2026-05-19: SMS + push removed from the UI. The schema still
// carries `sms_enabled`, `push_enabled`, `phone_e164`, `push_token`
// columns (low cost, latent future use), but neither channel is
// actually wired up — no Twilio, no PWA service-worker — so
// exposing toggles for them was misleading. The API still accepts
// the fields for compatibility; we just omit them from the PUT
// body and the server defaults them to false. Email is the only
// channel users can toggle today.
//
// Default-on (2026-05-19): new signups land with email_enabled=true
// via the register transaction; existing users were backfilled by
// migration 004. Settings page lets users opt out.
// ─────────────────────────────────────────────────────────────

import { useState } from 'react';
import Link from 'next/link';

interface Prefs {
  user_id:       string;
  email_enabled: boolean;
  // Carried for type-compat with the GET response shape, but not
  // surfaced in the form. Always sent as false in the PUT body.
  sms_enabled?:   boolean;
  push_enabled?:  boolean;
  hours_before:  number;
  email_addr:    string | null;
}

interface Props {
  initialPrefs: Prefs;
  profileEmail: string;
}

export default function NotificationPrefsForm({ initialPrefs, profileEmail }: Props) {
  const [emailEnabled, setEmailEnabled] = useState(initialPrefs.email_enabled);
  const [hoursBefore,  setHoursBefore]  = useState(initialPrefs.hours_before);
  const [emailAddr,    setEmailAddr]    = useState(initialPrefs.email_addr ?? '');

  const [saving,   setSaving]   = useState(false);
  const [savedAt,  setSavedAt]  = useState<Date | null>(null);
  const [errors,   setErrors]   = useState<Record<string, string>>({});
  const [topError, setTopError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setSavedAt(null); setErrors({}); setTopError('');
    try {
      const res = await fetch('/api/me/notification-prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email_enabled: emailEnabled,
          // sms_enabled / push_enabled deliberately omitted — the
          // server defaults them to false, which is the only state
          // they can be in until those channels are actually wired.
          hours_before:  hoursBefore,
          email_addr:    emailAddr.trim() || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.fieldErrors) setErrors(data.fieldErrors);
        else setTopError(data.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      setSavedAt(new Date());
    } catch (err) {
      setTopError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

      {/* ── Header / status ─────────────────────────────────── */}
      <div className="card">
        <h2 style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: '1.3rem', fontWeight: 700, marginBottom: '0.4rem',
        }}>
          Pick Reminders
        </h2>
        <p style={{ color: 'var(--slate-mid)', fontSize: '0.9rem', lineHeight: 1.5 }}>
          We&rsquo;ll nudge you when picks are about to lock so you don&rsquo;t miss a tournament.
          Email reminders are <strong>on by default</strong> — toggle off below if you&rsquo;d rather not get them.
        </p>
        {!emailEnabled && (
          <div className="alert alert-info" style={{ marginTop: '1rem' }}>
            <strong>Email reminders are off.</strong>{' '}
            Toggle on below to start getting reminded before each pick deadline.
          </div>
        )}
        {topError && (
          <div className="alert alert-error" style={{ marginTop: '1rem' }} role="alert">
            {topError}
          </div>
        )}
        {savedAt && (
          <div className="alert alert-success" style={{ marginTop: '1rem' }} role="status">
            ✓ Saved at {savedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.
          </div>
        )}
      </div>

      {/* ── Email channel ───────────────────────────────────── */}
      <ChannelCard
        title="Email"
        emoji="✉️"
        enabled={emailEnabled}
        onToggle={setEmailEnabled}
        helper={emailAddr.trim() || profileEmail || 'No email on file'}
      >
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
          disabled={!emailEnabled}
        />
        <p className="hint">
          Leave blank to use your account email. SMTP must be configured server-side
          before real emails are sent — until then, reminders are logged only.
        </p>
      </ChannelCard>

      {/* SMS + Push channels removed 2026-05-19 — not wired up
          (no Twilio relay, no PWA service worker). The schema still
          carries sms_enabled / push_enabled / phone_e164 / push_token
          columns and the reminder engine still gates on them; they
          just never get toggled true from the UI today. If those
          channels get wired up later, the cards can land back here
          without a schema change. */}

      {/* ── Reminder timing ─────────────────────────────────── */}
      <div className="card">
        <h3 style={{ fontWeight: 700, marginBottom: '0.4rem' }}>Reminder timing</h3>
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
          disabled={!emailEnabled}
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

      {/* ── Submit ──────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          type="submit"
          className="btn btn-primary btn-lg"
          disabled={saving}
          aria-busy={saving}
        >
          {saving ? 'Saving…' : 'Save preferences'}
        </button>
        <Link href="/dashboard" className="btn btn-ghost">Back to dashboard</Link>
      </div>
    </form>
  );
}

// ── Channel card subcomponent ────────────────────────────────

function ChannelCard({
  title, emoji, enabled, onToggle, helper, children,
}: {
  title:    string;
  emoji:    string;
  enabled:  boolean;
  onToggle: (b: boolean) => void;
  helper:   string;
  children: React.ReactNode;
}) {
  return (
    <div className="card" style={{
      borderLeft: `4px solid ${enabled ? 'var(--green-mid)' : 'var(--cream-dark)'}`,
    }}>
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: '0.75rem',
        flexWrap: 'wrap',
      }}>
        <div style={{ fontSize: '1.6rem', flexShrink: 0 }}>{emoji}</div>
        <div style={{ flex: '1 1 240px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
            <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.1rem', fontWeight: 700 }}>
              {title}
            </h3>
            <Toggle checked={enabled} onChange={onToggle} label={`Enable ${title} reminders`} />
          </div>
          <p style={{ color: 'var(--slate-mid)', fontSize: '0.82rem', marginTop: '0.1rem' }}>
            {helper}
          </p>
        </div>
      </div>
      {enabled && (
        <div style={{ marginTop: '1rem' }}>
          {children}
        </div>
      )}
    </div>
  );
}

// Plain checkbox-as-switch — no extra dep.
function Toggle({ checked, onChange, label }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        aria-label={label}
        style={{ width: 20, height: 20, accentColor: 'var(--green-mid)' }}
      />
      <span style={{ fontSize: '0.85rem', fontWeight: 600, color: checked ? 'var(--green-mid)' : 'var(--slate-mid)' }}>
        {checked ? 'On' : 'Off'}
      </span>
    </label>
  );
}
