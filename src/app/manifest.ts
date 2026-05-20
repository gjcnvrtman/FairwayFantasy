// ============================================================
// PWA MANIFEST — Add-to-Home-Screen support.
//
// Next.js App Router convention: a `manifest.ts` (or .json) in /app
// is served at `/manifest.webmanifest` AND auto-linked from <head>.
//
// Scope deliberately limited:
//   * Just the manifest + icons + theme color → "Add to Home Screen"
//     installs cleanly on iOS, Android, Chrome desktop, Edge.
//   * NO service worker / offline cache. The user base is on a LAN
//     deploy with stable wifi; offline caching is real engineering
//     (caching strategy, invalidation, version mismatches with the
//     server-side data flow) for marginal benefit. Punted explicitly.
//
// The 'icon' references point at /icon and /apple-icon — both are
// generated dynamically from icon.tsx and apple-icon.tsx in the same
// directory, so the manifest stays in sync with the favicon without
// duplicating image data.
// ============================================================

import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name:             'Fairway Fantasy',
    short_name:       'Fairway',
    description:      'Private golf fantasy leagues for your group. Pick 4 golfers, top 3 count.',
    start_url:        '/dashboard',
    // When launched from the home screen, open in standalone mode
    // (no browser chrome) so it behaves like a native app.
    display:          'standalone',
    background_color: '#f8f4ee', // --cream
    theme_color:      '#1a2f1e', // --green-deep — colors the status bar
    orientation:      'portrait',
    icons: [
      {
        src:     '/icon',
        sizes:   '192x192',
        type:    'image/png',
        purpose: 'any',
      },
      {
        src:     '/apple-icon',
        sizes:   '180x180',
        type:    'image/png',
        purpose: 'any',
      },
    ],
    // Categories help app launchers/search rank the install. Sports
    // is the obvious primary; games is secondary (fantasy = gameplay).
    categories: ['sports', 'games'],
  };
}
