import { createServerSupabaseClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import { supabaseAdmin } from '@/lib/supabase';
import Nav from '@/components/layout/Nav';
import NotificationPrefsForm from './NotificationPrefsForm';
import type { Metadata } from 'next';

// Per-user, auth-gated — never makes sense to prerender.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/auth/signin?redirect=/settings');

  const { data: profile } = await supabaseAdmin
    .from('profiles').select('*').eq('id', user.id).single();

  // Read existing prefs, OR fall through with defaults.
  const { data: prefs } = await supabaseAdmin
    .from('reminder_preferences').select('*').eq('user_id', user.id).single();

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
