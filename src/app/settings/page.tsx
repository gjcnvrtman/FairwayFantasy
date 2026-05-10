import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import Nav from '@/components/layout/Nav';
import NotificationPrefsForm from './NotificationPrefsForm';
import type { Metadata } from 'next';

// Per-user, auth-gated — never makes sense to prerender.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/auth/signin?redirect=/settings');

  const profile = await db.selectFrom('profiles')
    .selectAll()
    .where('id', '=', user.id)
    .executeTakeFirst();

  // Read existing prefs, OR fall through with defaults.
  const prefs = await db.selectFrom('reminder_preferences')
    .selectAll()
    .where('user_id', '=', user.id)
    .executeTakeFirst();

  const initialPrefs = prefs ?? {
    user_id:       user.id,
    email_enabled: false,
    sms_enabled:   false,
    push_enabled:  false,
    hours_before:  24,
    email_addr:    null,
    phone_e164:    null,
    push_token:    null,
  };

  return (
    <div className="page-shell">
      <Nav userName={profile?.display_name} />

      <div className="t-hero" style={{ padding: '2.5rem 1.5rem' }}>
        <div className="container">
          <p style={{
            color: 'rgba(255,255,255,0.5)', fontSize: '0.78rem', fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '0.4rem',
          }}>
            Account
          </p>
          <h1 style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: 'clamp(1.8rem,4vw,2.5rem)', fontWeight: 900,
          }}>
            Settings
          </h1>
        </div>
      </div>

      <div className="page-content">
        <div className="container" style={{ maxWidth: 720, margin: '0 auto' }}>
          <NotificationPrefsForm
            initialPrefs={initialPrefs}
            profileEmail={profile?.email ?? ''}
          />
        </div>
      </div>
    </div>
  );
}
