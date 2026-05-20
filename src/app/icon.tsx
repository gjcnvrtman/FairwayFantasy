// ============================================================
// FAVICON / PWA ICON — generated at request time via ImageResponse.
//
// Next.js App Router convention: a file named `icon.tsx` in /app
// is auto-wired as the site favicon at `/icon` AND auto-injected
// as <link rel="icon"> in <head>. No manual PNG management.
//
// The same image (rendered at 192x192) is referenced by the PWA
// manifest below at /manifest.webmanifest so "Add to Home Screen"
// uses the same artwork. iOS uses /apple-icon (separate file) per
// Apple's stricter convention.
// ============================================================

import { ImageResponse } from 'next/og';

// Edge runtime renders ImageResponse fastest.
export const runtime = 'edge';

// Next.js reads these to set <link rel="icon" sizes="..." type="..." />.
export const size = { width: 192, height: 192 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width:           '100%',
          height:          '100%',
          background:      '#1a2f1e', // --green-deep
          display:         'flex',
          alignItems:      'center',
          justifyContent:  'center',
          fontSize:        140,
          // Subtle brass-tinted text via filter — ImageResponse doesn't
          // support background-clip:text reliably, so we just lean on
          // the emoji's intrinsic colors against the green background.
        }}
      >
        ⛳
      </div>
    ),
    size,
  );
}
