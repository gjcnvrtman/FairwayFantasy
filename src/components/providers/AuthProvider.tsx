'use client';

// NextAuth's SessionProvider — required for `useSession()` /
// `signIn()` / `signOut()` from `next-auth/react`. Wraps the whole
// app in `layout.tsx`. Doesn't fetch anything until a child component
// actually subscribes, so it's free for routes that don't read the
// session client-side.

import { SessionProvider } from 'next-auth/react';
import type { ReactNode } from 'react';

export default function AuthProvider({ children }: { children: ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
