'use client';

// Re-fetches the current server component every `seconds` while
// mounted and the tab is visible. Score sync runs every 10 min, so a
// couple of minutes keeps live pages close without hammering the DB.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AutoRefresh({ seconds = 120 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, seconds * 1000);
    return () => window.clearInterval(id);
  }, [router, seconds]);
  return null;
}
