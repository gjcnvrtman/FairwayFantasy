// ============================================================
// iOS APPLE-TOUCH-ICON — Apple's home-screen icon convention.
//
// iOS Safari uses <link rel="apple-touch-icon"> with a 180x180 PNG
// for "Add to Home Screen." Next.js wires this automatically when
// a file named `apple-icon.tsx` exists in /app.
//
// Different from /icon.tsx in two ways:
//   * 180x180 (Apple's preferred size — see Apple HIG)
//   * No transparency — iOS rounds the corners itself, so the icon
//     must be a solid square. Pure colored background guarantees
//     correct rendering across iOS versions.
// ============================================================

import { ImageResponse } from 'next/og';

export const runtime = 'edge';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
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
          fontSize:        130,
        }}
      >
        ⛳
      </div>
    ),
    size,
  );
}
