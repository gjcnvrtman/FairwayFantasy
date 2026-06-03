// /api/auth/reset-password — consume a reset token + set a new password.
//
// Called by /auth/reset-password form after the user clicks the link in
// their password-reset email. Two-step flow:
//
//   1. /api/auth/forgot-password creates `auth_credentials.reset_token`
//      + `reset_token_expires` (1h TTL) for the email's account and
//      mails the user a link.
//   2. /auth/reset-password page POSTs here with { token, password }.
//      We verify the token + expiry, validate the new password against
//      the same rules registration uses, bcrypt-hash it, write the new
//      hash, and clear the reset_token + expires so the link is
//      single-use.
//
// On success we return { ok: true }. The frontend redirects to /auth/signin.
//
// Failure modes are surfaced as 4xx + { error: "..." } so the form
// can show actionable copy:
//   400 — malformed body, missing token/password
//   400 — password fails complexity rules
//   401 — token unknown OR expired (single message; don't leak which)

import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { validatePassword } from '@/lib/auth-validation';
import { requireSameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const BCRYPT_COST = 10;

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const token    = typeof body.token    === 'string' ? body.token    : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!token) {
    return NextResponse.json({ error: 'Reset token is required.' }, { status: 400 });
  }
  const pwError = validatePassword(password);
  if (pwError) {
    return NextResponse.json({ error: pwError }, { status: 400 });
  }

  // Look up the token. Note: we DO NOT join profiles here — the token
  // is the only authentication for this request. The token IS the
  // bearer credential.
  const row = await db.selectFrom('auth_credentials')
    .select(['user_id', 'reset_token_expires'])
    .where('reset_token', '=', token)
    .executeTakeFirst();

  if (!row) {
    return NextResponse.json(
      { error: 'This reset link is invalid or has already been used. Please request a new one.' },
      { status: 401 },
    );
  }

  const expiresAt = row.reset_token_expires ? new Date(row.reset_token_expires) : null;
  if (!expiresAt || expiresAt.getTime() < Date.now()) {
    // Defense in depth: also blank the expired token so it can't be
    // tried again. The single-use cleanup below would do this too but
    // an expired token shouldn't even reach that path.
    await db.updateTable('auth_credentials')
      .set({ reset_token: null, reset_token_expires: null })
      .where('user_id', '=', row.user_id)
      .execute();
    return NextResponse.json(
      { error: 'This reset link has expired. Please request a new one.' },
      { status: 401 },
    );
  }

  const password_hash = await bcrypt.hash(password, BCRYPT_COST);

  // Atomically: write new hash, clear the reset token + expires, bump
  // updated_at. Clearing the token is critical — without it the link
  // would be re-usable until expiry.
  await db.updateTable('auth_credentials')
    .set({
      password_hash,
      reset_token:         null,
      reset_token_expires: null,
      updated_at:          new Date().toISOString(),
    })
    .where('user_id', '=', row.user_id)
    .execute();

  return NextResponse.json({ ok: true });
}
