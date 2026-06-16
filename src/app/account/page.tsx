// Account page — formerly /settings (renamed 2026-06-06 to better
// match the user-visible nav label "Account"). Same per-user prefs
// surface, plus a Change Password card and the two recap toggles
// added in migration 009.

import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import { isPlatformAdmin } from '@/lib/platform-admin';
import Nav from '@/components/layout/Nav';
import AccountForm from './AccountForm';
import type { Metadata } from 'next';

// Per-user, auth-gated — never makes sense to prerender.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Account' };

export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/auth/signin?redirect=/account');

  const profile = await db.selectFrom('profiles')
    .selectAll()
    .where('id', '=', user.id)
    .executeTakeFirst();

  const prefs = await db.selectFrom('reminder_preferences')
    .selectAll()
    .where('user_id', '=', user.id)
    .executeTakeFirst();

  // Default to email reminders + both recaps ON when a row is somehow
  // missing. Production users all have a row (migration 004 backfilled
  // them, signup now seeds one). This fallback only fires for unusual
  // states (deleted-then-reseeded profiles, etc.).
  const initialPrefs = prefs ?? {
    user_id:                   user.id,
    email_enabled:             true,
    sms_enabled:               false,
    push_enabled:              false,
    nightly_recap_enabled:     true,
    tournament_recap_enabled:  true,
    field_published_enabled:   true,
    hours_before:              24,
    email_addr:                null,
    phone_e164:                null,
    push_token:                null,
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
            Your Account
          </p>
          <h1 style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: 'clamp(1.8rem,4vw,2.5rem)', fontWeight: 900,
          }}>
            Account
          </h1>
        </div>
      </div>

      <div className="page-content">
        <div className="container" style={{ maxWidth: 720, margin: '0 auto' }}>
          <AccountForm
            initialPrefs={initialPrefs}
            profileEmail={profile?.email ?? ''}
            profileDisplayName={profile?.display_name ?? ''}
            profileFirstName={profile?.first_name ?? ''}
            profileLastName={profile?.last_name ?? ''}
            isPlatformAdmin={isPlatformAdmin(profile?.email)}
          />
        </div>
      </div>
    </div>
  );
}
