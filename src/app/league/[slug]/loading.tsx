// Skeleton shown while the server component fetches league data.
// Mirrors the real layout closely enough that the page doesn't jump
// when data arrives.

export default function LeagueLoading() {
  return (
    <div className="page-shell" aria-busy="true" aria-live="polite">
      {/* Hero skeleton */}
      <div className="t-hero" style={{ padding: '2.5rem 1.5rem' }}>
        <div className="container">
          <div className="skeleton" style={{ height: 14, width: 120, marginBottom: '0.6rem', background: 'rgba(255,255,255,0.12)' }} />
          <div className="skeleton" style={{ height: 38, width: '60%', maxWidth: 360, marginBottom: '0.6rem', background: 'rgba(255,255,255,0.18)' }} />
          <div className="skeleton" style={{ height: 14, width: 200, background: 'rgba(255,255,255,0.12)' }} />
        </div>
      </div>

      <div className="page-content">
        <div className="container">
          {/* Lock-status row skeleton */}
          <div className="skeleton" style={{ height: 48, marginBottom: '1rem', borderRadius: 'var(--radius)' }} />

          <div style={{ display: 'flex', flexFlow: 'row wrap', gap: '1.5rem', alignItems: 'flex-start' }}>
            {/* Main column */}
            <div style={{ flex: '1 1 380px', minWidth: 0 }}>
              <div className="skeleton" style={{ height: 22, width: 200, marginBottom: '1rem' }} />
              <div className="skeleton" style={{ height: 100, marginBottom: '1rem', borderRadius: 'var(--radius-lg)' }} />
              <div className="skeleton" style={{ height: 360, borderRadius: 'var(--radius-lg)' }} />
            </div>
            {/* Sidebar */}
            <div style={{ flex: '0 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div className="skeleton" style={{ height: 200, borderRadius: 'var(--radius-lg)' }} />
              <div className="skeleton" style={{ height: 160, borderRadius: 'var(--radius-lg)' }} />
              <div className="skeleton" style={{ height: 180, borderRadius: 'var(--radius-lg)' }} />
            </div>
          </div>
        </div>
      </div>

      {/* Screen-reader-only fallback message in case visual skeleton is hidden */}
      <span className="sr-only">Loading league…</span>
    </div>
  );
}
