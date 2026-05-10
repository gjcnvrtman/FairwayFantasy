// ============================================================
// NEXTAUTH CONFIG (v5 / Auth.js)
//
// Credentials provider — email + password against the local
// `auth_credentials` table populated by Phase-3 schema and the
// Phase-5 migration script.
//
// Export shape:
//   - auth()   — server helper, used in pages / route handlers /
//                middleware via `@/lib/current-user.ts`
//   - signIn() / signOut() — server actions; the client-side
//                versions live in `next-auth/react`
//   - handlers — the App Router route exports
// ============================================================

import NextAuth, { type DefaultSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';

// ── Module augmentation: extend the default User/Session shape ──
declare module 'next-auth' {
  interface User {
    /** Always present on Fairway. Mirrors `profiles.display_name`. */
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

// (The JWT augmentation lives at @auth/core/jwt in v5; we don't
//  bother — the callbacks below cast as needed since the surface is
//  small.)

// ── Strong-secret guard ──────────────────────────────────────
// Match golf-czar's pattern: refuse to start with a weak/missing
// secret. Auth.js v5 reads NEXTAUTH_SECRET (or AUTH_SECRET).
const KNOWN_BAD_SECRETS = new Set([
  '',
  'change-me',
  'changeme',
  'secret',
  'replace-me',
]);
const _rawSecret = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET;
if (
  _rawSecret &&
  (KNOWN_BAD_SECRETS.has(_rawSecret) || _rawSecret.length < 32)
) {
  throw new Error(
    'FATAL: NEXTAUTH_SECRET is set but is too short (<32 chars) or ' +
    'matches a known placeholder. Generate a strong one with ' +
    '`openssl rand -base64 32` and put it in .env.local.',
  );
}
// Note: we don't throw when the secret is *missing* — Auth.js does
// that itself in production mode with a clear error. In development
// it auto-generates a transient one.

// ── Provider setup ───────────────────────────────────────────
export const { auth, handlers, signIn, signOut } = NextAuth({
  // Credentials provider requires JWT sessions — DB sessions
  // don't work because the provider is "stateless" in the Auth.js
  // model. JWT is signed with NEXTAUTH_SECRET on every request.
  session: { strategy: 'jwt' },

  // Custom auth pages so we render Fairway's UI, not Auth.js defaults.
  pages: {
    signIn: '/auth/signin',
    error:  '/auth/signin',  // surface errors on the same page
  },

  providers: [
    Credentials({
      name: 'Credentials',
      credentials: {
        email:    { label: 'Email',    type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const email    = String(credentials?.email ?? '').trim().toLowerCase();
        const password = String(credentials?.password ?? '');
        if (!email || !password) return null;

        // One query: profile + creds. Returning null on any miss keeps
        // the timing-attack surface narrow, but we DON'T do a full
        // constant-time path here — bcrypt.compare itself is the
        // slow part, so an attacker can't easily distinguish "no user"
        // from "wrong password" by timing.
        const row = await db.selectFrom('profiles')
          .innerJoin('auth_credentials', 'auth_credentials.user_id', 'profiles.id')
          .select([
            'profiles.id',
            'profiles.email',
            'profiles.display_name',
            'auth_credentials.password_hash',
          ])
          .where('profiles.email', '=', email)
          .executeTakeFirst();

        if (!row) {
          // Equalize timing roughly with the real-compare branch by
          // running a throwaway compare against a known hash. (Not
          // perfect, but better than returning instantly.)
          await bcrypt.compare(
            password,
            '$2a$10$CwTycUXWue0Thq9StjUM0uJ8v.t7l4LZ3zJ9ZJZj8w8Z5w8O8w8O8',
          );
          return null;
        }

        const ok = await bcrypt.compare(password, row.password_hash);
        if (!ok) return null;

        // Best-effort `last_login_at` update — never blocks login.
        db.updateTable('auth_credentials')
          .set({ last_login_at: new Date().toISOString() })
          .where('user_id', '=', row.id)
          .execute()
          .catch(err => console.error('last_login_at update failed:', err));

        return {
          id:    row.id,
          email: row.email,
          name:  row.display_name,
        };
      },
    }),
  ],

  callbacks: {
    // Persist user fields onto the JWT at sign-in time. The token's
    // own type is opaque in v5; we just stash extra fields and read
    // them back in `session()` with a cast.
    async jwt({ token, user }) {
      if (user) {
        (token as Record<string, unknown>).id           = user.id;
        (token as Record<string, unknown>).display_name = user.name ?? null;
      }
      return token;
    },
    // Surface those fields on the session object the app reads.
    async session({ session, token }) {
      const t = token as Record<string, unknown>;
      if (typeof t.id           === 'string') session.user.id    = t.id;
      if (typeof t.display_name === 'string') session.user.name  = t.display_name;
      if (typeof t.email        === 'string') session.user.email = t.email;
      return session;
    },
  },
});
