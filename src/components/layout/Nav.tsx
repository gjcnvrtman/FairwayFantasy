'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut as nextAuthSignOut } from 'next-auth/react';
import { useRouter } from 'next/navigation';

interface NavProps {
  leagueSlug?: string;
  leagueName?: string;
  userName?: string;
}

export default function Nav({ leagueSlug, leagueName, userName }: NavProps) {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    // Clears the NextAuth session cookie + bounces home.
    await nextAuthSignOut({ redirect: false });
    router.push('/');
    router.refresh();
  }

  return (
    <nav className="nav">
      <div className="nav-inner">
        <Link href={leagueSlug ? `/league/${leagueSlug}` : '/dashboard'} className="nav-logo">
          Fairway <span>Fantasy</span>
        </Link>

        {leagueSlug && (
          <ul className="nav-links">
            <li>
              <Link
                href={`/league/${leagueSlug}`}
                className={pathname === `/league/${leagueSlug}` ? 'active' : ''}
              >
                Leaderboard
              </Link>
            </li>
            <li>
              <Link
                href={`/league/${leagueSlug}/picks`}
                className={pathname.includes('/picks') ? 'active' : ''}
              >
                My Picks
              </Link>
            </li>
            <li>
              <Link
                href={`/league/${leagueSlug}/history`}
                className={pathname.includes('/history') ? 'active' : ''}
              >
                History
              </Link>
            </li>
          </ul>
        )}

        <div className="nav-actions">
          {userName && (
            <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: '0.85rem' }}>
              {userName}
            </span>
          )}
          {leagueSlug && (
            <Link href="/dashboard" className="btn btn-ghost btn-sm" style={{ color: 'rgba(255,255,255,0.6)' }}>
              My Leagues
            </Link>
          )}
          <button onClick={signOut} className="btn btn-ghost btn-sm" style={{ color: 'rgba(255,255,255,0.6)' }}>
            Sign Out
          </button>
        </div>
      </div>
    </nav>
  );
}
