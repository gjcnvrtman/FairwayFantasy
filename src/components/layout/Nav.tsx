'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut as nextAuthSignOut } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

interface NavProps {
  leagueSlug?: string;
  leagueName?: string;
  userName?: string;
}

export default function Nav({ leagueSlug, leagueName, userName }: NavProps) {
  const pathname = usePathname();
  const router = useRouter();

  // Mobile drawer open/close. Default closed on every nav-mount so a
  // route change leaves it dismissed. Esc + backdrop click also close.
  // We DON'T persist the open state across pages — that's intentional;
  // a tap on a link should always feel like "took me there" not "drawer
  // hung around."
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('keydown', onKey);
    // Lock background scroll while drawer is open so the page doesn't
    // scroll behind it (esp. on iOS where rubber-banding is jarring).
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [menuOpen]);

  async function signOut() {
    await nextAuthSignOut({ redirect: false });
    router.push('/');
    router.refresh();
  }

  // Single source of truth for the link list — rendered both in the
  // desktop top-bar and inside the mobile drawer so they can't drift.
  const leagueLinks = leagueSlug ? [
    { href: `/league/${leagueSlug}`,          label: 'Leaderboard', match: (p: string) => p === `/league/${leagueSlug}` },
    { href: `/league/${leagueSlug}/picks`,    label: 'My Picks',    match: (p: string) => p.includes('/picks') },
    { href: `/league/${leagueSlug}/schedule`, label: 'Schedule',    match: (p: string) => p.includes('/schedule') },
    { href: `/league/${leagueSlug}/history`,  label: 'History',     match: (p: string) => p.includes('/history') },
    { href: `/league/${leagueSlug}/stats`,    label: 'Stats',       match: (p: string) => p.includes('/stats') },
  ] : [];

  return (
    <>
      <nav className="nav">
        <div className="nav-inner">
          <Link
            href={leagueSlug ? `/league/${leagueSlug}` : '/dashboard'}
            className="nav-logo"
            onClick={() => setMenuOpen(false)}
          >
            Fairway <span>Fantasy</span>
          </Link>

          {leagueSlug && (
            <ul className="nav-links">
              {leagueLinks.map(l => (
                <li key={l.href}>
                  <Link href={l.href} className={l.match(pathname) ? 'active' : ''}>
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <div className="nav-actions">
            {userName && (
              <span className="nav-username">
                {userName}
              </span>
            )}
            {leagueSlug && (
              <Link href="/dashboard" className="btn btn-ghost btn-sm nav-desktop-only" style={{ color: 'rgba(255,255,255,0.6)' }}>
                My Leagues
              </Link>
            )}
            {userName && (
              <Link
                href="/account"
                className={
                  'btn btn-ghost btn-sm nav-desktop-only ' + (pathname === '/account' ? 'active' : '')
                }
                style={{ color: 'rgba(255,255,255,0.6)' }}
              >
                Account
              </Link>
            )}
            <button
              onClick={signOut}
              className="btn btn-ghost btn-sm nav-desktop-only"
              style={{ color: 'rgba(255,255,255,0.6)' }}
            >
              Sign Out
            </button>

            {/* Hamburger — visible only on mobile. Toggles the drawer
                below. aria-expanded for screen readers. */}
            <button
              type="button"
              className="nav-hamburger"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(v => !v)}
            >
              {menuOpen ? '✕' : '☰'}
            </button>
          </div>
        </div>
      </nav>

      {/* Mobile drawer overlay — only rendered when open. Backdrop
          captures clicks to dismiss. Drawer body stops propagation so
          taps INSIDE it don't immediately close. */}
      {menuOpen && (
        <div
          className="nav-drawer-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
          onClick={() => setMenuOpen(false)}
        >
          <div className="nav-drawer" onClick={e => e.stopPropagation()}>
            <div className="nav-drawer-head">
              <span className="nav-drawer-brand">
                Fairway <span style={{ color: 'white' }}>Fantasy</span>
              </span>
              <button
                type="button"
                aria-label="Close menu"
                className="nav-drawer-close"
                onClick={() => setMenuOpen(false)}
              >
                ✕
              </button>
            </div>
            {leagueSlug && (
              <>
                <p className="nav-drawer-section-label">
                  {leagueName || 'League'}
                </p>
                <ul className="nav-drawer-links">
                  {leagueLinks.map(l => (
                    <li key={l.href}>
                      <Link
                        href={l.href}
                        className={l.match(pathname) ? 'active' : ''}
                        onClick={() => setMenuOpen(false)}
                      >
                        {l.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <p className="nav-drawer-section-label">
              Account
            </p>
            <ul className="nav-drawer-links">
              {leagueSlug && (
                <li>
                  <Link href="/dashboard" onClick={() => setMenuOpen(false)}>My Leagues</Link>
                </li>
              )}
              {userName && (
                <li>
                  <Link
                    href="/account"
                    className={pathname === '/account' ? 'active' : ''}
                    onClick={() => setMenuOpen(false)}
                  >
                    Account
                  </Link>
                </li>
              )}
              <li>
                <button
                  type="button"
                  onClick={() => { setMenuOpen(false); signOut(); }}
                  className="nav-drawer-signout"
                >
                  Sign Out
                </button>
              </li>
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
