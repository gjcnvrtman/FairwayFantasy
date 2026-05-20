import type { Metadata, Viewport } from 'next';
import './globals.css';
import AuthProvider from '@/components/providers/AuthProvider';

export const metadata: Metadata = {
  title: { default: 'Fairway Fantasy', template: '%s · Fairway Fantasy' },
  description: 'Private golf fantasy leagues for your group. Pick 4 golfers, top 3 count.',
  // Next.js auto-injects <link rel="manifest" href="/manifest.webmanifest" />
  // from src/app/manifest.ts; the explicit reference here is belt-and-
  // suspenders and also documents the path for anyone reading metadata
  // in one place.
  manifest: '/manifest.webmanifest',
  // Apple-specific PWA hints. iOS uses these for "Add to Home Screen"
  // alongside the icon from apple-icon.tsx.
  appleWebApp: {
    capable:        true,
    title:          'Fairway',
    statusBarStyle: 'black-translucent',
  },
  openGraph: {
    title: 'Fairway Fantasy',
    description: 'Private golf fantasy leagues for your group.',
    type: 'website',
  },
};

// Viewport lives in its own export per Next.js 14's split. theme_color
// paints the mobile address-bar / status-bar to match the brand green
// so the seam between OS chrome and the in-app hero is invisible.
export const viewport: Viewport = {
  themeColor:    '#1a2f1e', // --green-deep
  width:         'device-width',
  initialScale:  1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
