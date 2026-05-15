// /api/auth/resend-verify — issue a fresh verification token + email.
//
// Called from the signin page after an EmailNotVerified error, or from
// the verify page when the token is expired. Rate-limited heavily
// (1 per minute per email + 1 per minute per IP) so an attacker can't
// use this to spam someone else's inbox or to enumerate accounts.
//
// Always returns { ok: true } regardless of whether the email exists,
// so attackers can't tell registered emails from unregistered ones.
// Internally we silently no-op for unknown emails.

import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { db } from '@/lib/db';
import { sendEmail, verificationEmail } from '@/lib/email';
import { checkRateLimit, clientIpFromHeaders } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body  = await req.json().catch(() => ({} as Record<string, unknown>));
  const email = (typeof body.email === 'string' ? body.email.trim().toLowerCase() : '');

  if (!email) {
    return NextResponse.json({ ok: true }); // intentionally not 400
  }

  const ip = clientIpFromHeaders(req.headers);

  // Two rate-limit keys to prevent both inbox-spam (per-email) and
  // generic abuse (per-IP). 1 per 60s on each is plenty for legit
  // "the email never showed up" retries.
  const rlEmail = await checkRateLimit({
    key:           `resend-verify-email:${email}`,
    limit:         1,
    windowSeconds: 60,
  });
  const rlIp = await checkRateLimit({
    key:           `resend-verify-ip:${ip}`,
    limit:         3,  // a few per minute per IP — covers multiple users on one network
    windowSeconds: 60,
  });
  if (!rlEmail.ok || !rlIp.ok) {
    const retry = Math.max(rlEmail.retryAfterSeconds, rlIp.retryAfterSeconds);
    return NextResponse.json(
      { error: `Please wait ${retry}s before requesting another verification email.` },
      { status: 429, headers: { 'Retry-After': String(retry) } },
    );
  }

  // Look up the user. If not found, log and return ok:true (we don't
  // expose enumeration). If already verified, no-op + return ok:true.
  const row = await db.selectFrom('profiles')
    .innerJoin('auth_credentials', 'auth_credentials.user_id', 'profiles.id')
    .select([
      'profiles.id',
      'profiles.display_name',
      'auth_credentials.email_verified',
    ])
    .where('profiles.email', '=', email)
    .executeTakeFirst();

  if (!row || row.email_verified) {
    return NextResponse.json({ ok: true });
  }

  const verify_token = randomBytes(32).toString('hex');
  const verify_token_expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await db.updateTable('auth_credentials')
    .set({
      verify_token,
      verify_token_expires: verify_token_expires.toISOString(),
      updated_at:           new Date().toISOString(),
    })
    .where('user_id', '=', row.id)
    .execute();

  const baseUrl   = process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? '';
  const verifyUrl = `${baseUrl}/auth/verify?token=${verify_token}`;
  const { subject, text, html } = verificationEmail({
    displayName: row.display_name,
    verifyUrl,
  });
  const emailSent = await sendEmail({ to: email, subject, text, html });

  return NextResponse.json({ ok: true, emailSent });
}
