// ============================================================
// /predictions layout — admin gate + sidebar nav.
//
// All routes under /predictions are gated to platform admins (Greg
// + MJ). Non-admins get a clean 404 to hide the feature's existence,
// matching the API route convention.
//
// Phase 3 v1 surfaces two child routes:
//   - /predictions/current   — the upcoming tournament + run trigger
//   - /predictions/courses   — list + create course profiles
//
// Future slices add /backtest, /stats, /weights tabs.
// ============================================================

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/current-user';
import { isPlatformAdmin } from '@/lib/platform-admin';

export const metadata = { title: 'Predictions (admin)' };

export default async function PredictionsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user || !user.email || !isPlatformAdmin(user.email)) {
    notFound();
  }

  return (
    <div style={{
      display: 'flex',
      minHeight: '100vh',
      backgroundColor: '#f7f7f5',
    }}>
      {/* Sidebar — single source of nav inside /predictions */}
      <aside style={{
        width: '220px',
        backgroundColor: '#1a3a2e',
        color: '#fff',
        padding: '24px 16px',
        flexShrink: 0,
      }}>
        <Link
          href="/predictions"
          style={{
            display: 'block',
            fontSize: '18px',
            fontWeight: 700,
            marginBottom: '32px',
            color: '#fff',
            textDecoration: 'none',
          }}
        >
          Predictions
        </Link>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <Link href="/predictions/current"  style={navLinkStyle}>Current Tournament</Link>
          <Link href="/predictions/courses"  style={navLinkStyle}>Course Profiles</Link>
          <Link href="/predictions/stats"    style={navLinkStyle}>Stats Snapshots</Link>
          <Link href="/predictions/weights"  style={navLinkStyle}>Model Weights</Link>
          <Link href="/predictions/backtest" style={navLinkStyle}>Backtest</Link>
        </nav>
        <p style={{
          marginTop: '40px',
          fontSize: '12px',
          color: '#9bb',
          lineHeight: 1.4,
        }}>
          Admin-only feature. These are model predictions, not guarantees.
        </p>
      </aside>

      {/* Main content */}
      <main style={{ flex: 1, padding: '32px' }}>
        {children}
      </main>
    </div>
  );
}

const navLinkStyle: React.CSSProperties = {
  display: 'block',
  padding: '8px 12px',
  color: '#cde',
  textDecoration: 'none',
  borderRadius: '4px',
  fontSize: '14px',
};
