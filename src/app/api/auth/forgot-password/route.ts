// /api/auth/forgot-password — issue a password-reset token + email.
//
// Mirrors /api/auth/resend-verify in spirit:
//   * Rate-limited per-email + per-IP so an attacker can't spam an
//     inbox or enumerate registered accounts.
//   * Always returns { ok: true } regardless of whether the email
//     exists. Internally we silently no-op for unknown emails so
//     timing / response shape don't reveal account existence.
//   * Token TTL is 1 hour (shorter than verify's 7 days — password
//     reset is a higher-value target).
//
// On success the user receives an email with a link to
// /auth/reset-password?token=<32-byte hex>. That page POSTs to
// /api/auth/reset-password with { token, password } to finish.

import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { db } from '@/lib/db';
import { sendEmail, passwordResetEmail } from '@/lib/email';
import { checkRateLimit, clientIpFromHeaders } from '@/lib/rate-limit';
import { requireSameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const body  = await req.json().catch(() => ({} as Record<string, unknown>));
  const email = (typeof body.email === 'string' ? body.email.trim().toLowerCase() : '');

  // Empty email → still return ok to avoid leaking a difference
  // between "no email" and "valid format, unknown user".
  if (!email) {
    return NextResponse.json({ ok: true });
  }

  const ip = clientIpFromHeaders(req.headers);

  // Two rate-limit keys: 1/min per-email (inbox protection) and 3/min
  // per-IP (general abuse). Matches the resend-verify shape.
  const rlEmail = await checkRateLimit({
    key:           `forgot-password-email:${email}`,
    limit:         1,
    windowSeconds: 60,
  });
  const rlIp = await checkRateLimit({
    key:           `forgot-password-ip:${ip}`,
    limit:         3,
    windowSeconds: 60,
  });
  if (!rlEmail.ok || !rlIp.ok) {
    const retry = Math.max(rlEmail.retryAfterSeconds, rlIp.retryAfterSeconds);
    return NextResponse.json(
      { error: `Please wait ${retry}s before requesting another reset email.` },
      { status: 429, headers: { 'Retry-After': String(retry) } },
    );
  }

  // Look up the user. Missing user OR unverified email → silently
  // no-op + return ok:true (don't expose enumeration; also don't let
  // someone reset an account before they prove they own the email).
  const row = await db.selectFrom('profiles')
    .innerJoin('auth_credentials', 'auth_credentials.user_id', 'profiles.id')
    .select([
      'profiles.id',
      'profiles.display_name',
      'auth_credentials.email_verified',
    ])
    .where('profiles.email', '=', email)
    .executeTakeFirst();

  if (!row || !row.email_verified) {
    return NextResponse.json({ ok: true });
  }

  // Generate token + persist with 1h expiry. We OVERWRITE any prior
  // reset_token so a second reset request invalidates the first link
  // — limits the window of replay-able tokens to one at a time.
  const reset_token = randomBytes(32).toString('hex');
  const reset_token_expires = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  await db.updateTable('auth_credentials')
    .set({
      reset_token,
      reset_token_expires: reset_token_expires.toISOString(),
      updated_at:          new Date().toISOString(),
    })
    .where('user_id', '=', row.id)
    .execute();

  const baseUrl  = process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? '';
  const resetUrl = `${baseUrl}/auth/reset-password?token=${reset_token}`;
  const { subject, text, html } = passwordResetEmail({
    displayName: row.display_name,
    resetUrl,
  });
  // Best-effort — sendEmail returns false when SMTP isn't configured
  // (dev / test environments). The user-facing response is still ok:true
  // so production error paths and dev no-op paths look identical to the
  // browser. Operators looking at server logs will see the warning.
  await sendEmail({ to: email, subject, text, html });

  return NextResponse.json({ ok: true });
}
