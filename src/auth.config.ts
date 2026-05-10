// ============================================================
// NEXTAUTH CONFIG — edge-safe shared layer.
//
// Why this file exists:
//   Next.js middleware runs in the Edge Runtime, a stripped V8
//   sandbox without Node APIs (no `crypto`, no `pg`, no `bcrypt`).
//   Importing `auth.ts` directly into middleware drags Credentials
//   provider + bcrypt + kysely along, and the bundler crashes with
//   "The edge runtime does not support Node.js 'crypto' module."
//
// Solution (official Auth.js v5 split-config pattern):
//   1. This file holds ONLY the bits middleware needs — pages,
//      session strategy, jwt/session callbacks. Pure JS, no Node
//      APIs touched.
//   2. `src/middleware.ts` builds a NextAuth instance from THIS
//      file alone — no providers, no DB.
//   3. `src/auth.ts` extends this config with the Credentials
//      provider and runs in the Node runtime (API routes, RSCs).
//
// Both layers use the same JWT signed with the same NEXTAUTH_SECRET,
// so cookies set by the auth.ts handlers are valid in middleware
// and vice versa.
// ============================================================

import type { NextAuthConfig, DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface User {
    name?: string | null;
  }
  interface Session {
    user: {
      id:    string;          // profiles.id (UUID)
      email: string;
      name:  string;
    } & DefaultSession['user'];
  }
}

export const authConfig = {
  // JWT sessions — required by the Credentials provider in auth.ts,
  // and edge middleware can verify them without a DB roundtrip.
  session: { strategy: 'jwt' },

  pages: {
    signIn: '/auth/signin',
    error:  '/auth/signin',
  },

  // No providers here — added in auth.ts where the Node runtime
  // can do bcrypt + DB. Middleware doesn't need providers because
  // it only READS the session, never authenticates.
  providers: [],

  callbacks: {
    // Persist extra fields onto the JWT at sign-in. JWT signing is
    // edge-safe — uses Web Crypto, not Node's crypto.
    async jwt({ token, user }) {
      if (user) {
        (token as Record<string, unknown>).id           = user.id;
        (token as Record<string, unknown>).display_name = user.name ?? null;
      }
      return token;
    },

    // Surface those fields on the session object app code consumes.
    async session({ session, token }) {
      const t = token as Record<string, unknown>;
      if (typeof t.id           === 'string') session.user.id    = t.id;
      if (typeof t.display_name === 'string') session.user.name  = t.display_name;
      if (typeof t.email        === 'string') session.user.email = t.email;
      return session;
    },
  },
} satisfies NextAuthConfig;
