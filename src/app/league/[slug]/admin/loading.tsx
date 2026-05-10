// Skeleton for /league/[slug]/admin while server fetches members
// + tournaments. Mirrors the panel's section layout to avoid jump.

export default function AdminLoading() {
  return (
    <div className="page-shell" aria-busy="true" aria-live="polite">
      <div className="t-hero" style={{ padding: '2.5rem 1.5rem' }}>
        <div className="container">
          <div className="skeleton" style={{ height: 14, width: 160, marginBottom: '0.6rem', background: 'rgba(255,255,255,0.12)' }} />
          <div className="skeleton" style={{ height: 36, width: '50%', maxWidth: 360, background: 'rgba(255,255,255,0.18)' }} />
        </div>
      </div>

      <div className="page-content">
        <div className="container" style={{ maxWidth: 920, margin: '0 auto' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* Settings card */}
            <div className="skeleton" style={{ height: 200, borderRadius: 'var(--radius-lg)' }} />
            {/* Sync card */}
            <div className="skeleton" style={{ height: 200, borderRadius: 'var(--radius-lg)' }} />
            {/* Invite card */}
            <div className="skeleton" style={{ height: 240, borderRadius: 'var(--radius-lg)' }} />
            {/* Members table */}
            <div className="skeleton" style={{ height: 320, borderRadius: 'var(--radius-lg)' }} />
            {/* Tournaments table */}
            <div className="skeleton" style={{ height: 280, borderRadius: 'var(--radius-lg)' }} />
          </div>
        </div>
      </div>

      <span className="sr-only">Loading admin panel…</span>
    </div>
  );
}
