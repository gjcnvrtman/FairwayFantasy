// ============================================================
// NEXTAUTH — Node-runtime layer (Credentials provider + DB).
//
// Imports the shared edge-safe config from `auth.config.ts` and
// adds the heavy stuff that can't live in the edge runtime:
//   - Credentials provider's authorize() (bcrypt-compares against
//     the auth_credentials table — uses Node `crypto` via bcryptjs
//     and `pg` via kysely)
//   - last_login_at writeback
//
// Used by:
//   - src/lib/current-user.ts (auth() helper for RSCs / route handlers)
//   - src/app/api/auth/[...nextauth]/route.ts (the catch-all routes)
//
// NOT imported by middleware — middleware uses authConfig directly.
// ============================================================

import NextAuth, { CredentialsSignin } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { authConfig } from './auth.config';

// Surfaced to the signin page so it can render "please verify your
// email" with a Resend button instead of the generic
// "invalid credentials" copy. The signin form reads `error.code`.
class EmailNotVerifiedError extends CredentialsSignin {
  code = 'EmailNotVerified';
}

// ── Strong-secret guard ──────────────────────────────────────
// Refuse to start with a weak/missing secret (mirrors golf-czar's
// pattern). Auth.js reads NEXTAUTH_SECRET (or AUTH_SECRET).
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
// We don't throw on MISSING — Auth.js handles that itself with a
// clear production-mode error, and dev mode auto-generates one.

// ── Provider setup ───────────────────────────────────────────
export const { auth, handlers, signIn, signOut } = NextAuth({
  ...authConfig,

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

        // One query: profile + creds. bcrypt.compare is the slow path,
        // so the timing-attack surface is narrow even when the email
        // doesn't exist (we run a throwaway compare in that branch).
        const row = await db.selectFrom('profiles')
          .innerJoin('auth_credentials', 'auth_credentials.user_id', 'profiles.id')
          .select([
            'profiles.id',
            'profiles.email',
            'profiles.display_name',
            'auth_credentials.password_hash',
            'auth_credentials.email_verified',
          ])
          .where('profiles.email', '=', email)
          .executeTakeFirst();

        if (!row) {
          // Equalize timing with the real-compare branch.
          await bcrypt.compare(
            password,
            '$2a$10$CwTycUXWue0Thq9StjUM0uJ8v.t7l4LZ3zJ9ZJZj8w8Z5w8O8w8O8',
          );
          return null;
        }

        const ok = await bcrypt.compare(password, row.password_hash);
        if (!ok) return null;

        // Email-verification gate (P0 hardening 2026-05-15). Existing
        // pre-deploy users are backfilled to email_verified=true so
        // they aren't locked out. New users must click the verify
        // link in their welcome email before they can sign in.
        if (!row.email_verified) {
          throw new EmailNotVerifiedError();
        }

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
});
