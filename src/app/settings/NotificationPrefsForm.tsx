'use client';

// ─────────────────────────────────────────────────────────────
// Notification preferences form.
//
// Privacy stance: every channel is OFF by default. Users must
// actively toggle on. SMS / push won't actually send anything in
// the current build (notifier is in console-only mode unless
// REMINDERS_LIVE=true), but enabling them here still records
// intent and validates the destination.
// ─────────────────────────────────────────────────────────────

import { useState } from 'react';
import Link from 'next/link';

interface Prefs {
  user_id:       string;
  email_enabled: boolean;
  sms_enabled:   boolean;
  push_enabled:  boolean;
  hours_before:  number;
  email_addr:    string | null;
  phone_e164:    string | null;
  push_token:    string | null;
}

interface Props {
  initialPrefs: Prefs;
  profileEmail: string;
}

export default function NotificationPrefsForm({ initialPrefs, profileEmail }: Props) {
  const [emailEnabled, setEmailEnabled] = useState(initialPrefs.email_enabled);
  const [smsEnabled,   setSmsEnabled]   = useState(initialPrefs.sms_enabled);
  const [pushEnabled,  setPushEnabled]  = useState(initialPrefs.push_enabled);
  const [hoursBefore,  setHoursBefore]  = useState(initialPrefs.hours_before);
  const [emailAddr,    setEmailAddr]    = useState(initialPrefs.email_addr ?? '');
  const [phoneE164,    setPhoneE164]    = useState(initialPrefs.phone_e164 ?? '');
  // Push token is acquired via a service-worker subscription flow.
  // Surface as read-only until that lands.
  const pushToken = initialPrefs.push_token ?? '';

  const [saving,   setSaving]   = useState(false);
  const [savedAt,  setSavedAt]  = useState<Date | null>(null);
  const [errors,   setErrors]   = useState<Record<string, string>>({});
  const [topError, setTopError] = useState('');

  const anyEnabled = emailEnabled || smsEnabled || pushEnabled;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setSavedAt(null); setErrors({}); setTopError('');
    try {
      const res = await fetch('/api/me/notification-prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email_enabled: emailEnabled,
          sms_enabled:   smsEnabled,
          push_enabled:  pushEnabled,
          hours_before:  hoursBefore,
          email_addr:    emailAddr.trim() || null,
          phone_e164:    phoneE164.trim() || null,
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
          Every channel below is <strong>off by default</strong>. Enable just the ones you want.
        </p>
        {!anyEnabled && (
          <div className="alert alert-info" style={{ marginTop: '1rem' }}>
            <strong>All reminders are currently off.</strong>{' '}
            Toggle a channel below to start getting reminded.
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

      {/* ── SMS channel ─────────────────────────────────────── */}
      <ChannelCard
        title="SMS"
        emoji="💬"
        enabled={smsEnabled}
        onToggle={setSmsEnabled}
        helper={phoneE164.trim() || 'No phone number set'}
      >
        <label className="label" htmlFor="phone_e164">Phone number (E.164)</label>
        <input
          id="phone_e164"
          className="input"
          type="tel"
          inputMode="tel"
          placeholder="+15551234567"
          value={phoneE164}
          onChange={e => setPhoneE164(e.target.value)}
          disabled={!smsEnabled}
          aria-invalid={!!errors.phone_e164}
        />
        {errors.phone_e164 && <p className="hint" style={{ color: 'var(--red)' }}>{errors.phone_e164}</p>}
        <p className="hint">
          Format: country code + number, no spaces (e.g. <code>+15551234567</code>).
          Twilio (or similar) must be configured server-side before real SMS goes out.
        </p>
      </ChannelCard>

      {/* ── Push channel ────────────────────────────────────── */}
      <ChannelCard
        title="Push"
        emoji="🔔"
        enabled={pushEnabled}
        onToggle={setPushEnabled}
        helper={pushToken ? 'Subscribed' : 'Browser not yet subscribed'}
      >
        <p className="hint">
          Web push will be wired up once the PWA service-worker lands.
          Toggling on today records intent only — reminders won&rsquo;t actually fire to your device yet.
        </p>
        {errors.push_token && <p className="hint" style={{ color: 'var(--red)' }}>{errors.push_token}</p>}
      </ChannelCard>

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
          disabled={!anyEnabled}
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
