// Skeleton for /dashboard while server fetches the user's leagues
// and upcoming events.

export default function DashboardLoading() {
  return (
    <div className="page-shell" aria-busy="true" aria-live="polite">
      <div className="t-hero" style={{ padding: '2.5rem 1.5rem' }}>
        <div className="container">
          <div className="skeleton" style={{ height: 14, width: 120, marginBottom: '0.6rem', background: 'rgba(255,255,255,0.12)' }} />
          <div className="skeleton" style={{ height: 36, width: '40%', maxWidth: 280, marginBottom: '0.6rem', background: 'rgba(255,255,255,0.18)' }} />
          <div className="skeleton" style={{ height: 14, width: 100, background: 'rgba(255,255,255,0.12)' }} />
        </div>
      </div>

      <div className="page-content">
        <div className="container">
          <div style={{ display: 'flex', flexFlow: 'row wrap', gap: '2rem', alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 360px', minWidth: 0 }}>
              <div className="skeleton" style={{ height: 28, width: 180, marginBottom: '1.25rem' }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
                {[0, 1, 2].map(i => (
                  <div key={i} className="skeleton"
                       style={{ height: 80, borderRadius: 'var(--radius-lg)' }} />
                ))}
              </div>
            </div>
            <div style={{ flex: '0 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div className="skeleton" style={{ height: 220, borderRadius: 'var(--radius-lg)' }} />
              <div className="skeleton" style={{ height: 160, borderRadius: 'var(--radius-lg)' }} />
            </div>
          </div>
        </div>
      </div>

      <span className="sr-only">Loading dashboard…</span>
    </div>
  );
}
