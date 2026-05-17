// /api/auth/register — public POST. Creates a profile + auth_credentials
// + league_members row in one transaction, hashes the password with
// bcrypt cost 10. Does NOT auto-login; the signup form calls signIn()
// right after.
//
// Invite-only signup (2026-05-15, P0 hardening): registration now
// requires a valid leagueSlug + inviteCode pair that matches a row
// in the leagues table. Anyone arriving at /auth/signup without an
// invite is rejected at the server, even if they bypass the form.

import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { db } from '@/lib/db';
import { validateRegistration } from '@/lib/auth-validation';
import { checkRateLimit, clientIpFromHeaders } from '@/lib/rate-limit';
import { sendEmail, verificationEmail } from '@/lib/email';

// Auth flow — never prerender.
export const dynamic = 'force-dynamic';

const BCRYPT_COST = 10;

// Per-IP rate limit: 5 registration attempts per 10 minutes. Tuned
// for legitimate use (no one signs up 6 times in 10 min) while
// blocking brute-force account enumeration / spam signup attempts.
const RL_REGISTER_LIMIT  = 5;
const RL_REGISTER_WINDOW = 600;

export async function POST(req: NextRequest) {
  // Rate limit before any work — cheap and means a scripted attacker
  // can't exhaust the bcrypt pool or the DB connection pool.
  const ip = clientIpFromHeaders(req.headers);
  const rl = await checkRateLimit({
    key:           `register:${ip}`,
    limit:         RL_REGISTER_LIMIT,
    windowSeconds: RL_REGISTER_WINDOW,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Too many signup attempts. Try again in ${rl.retryAfterSeconds}s.` },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds) } },
    );
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>));

  const email        = typeof body.email        === 'string' ? body.email.trim().toLowerCase() : '';
  const display_name = typeof body.display_name === 'string' ? body.display_name.trim()         : '';
  const password     = typeof body.password     === 'string' ? body.password                    : '';
  const leagueSlug   = typeof body.leagueSlug   === 'string' ? body.leagueSlug.trim()           : '';
  const inviteCode   = typeof body.inviteCode   === 'string' ? body.inviteCode.trim()           : '';

  // Single source of truth for format validation — same fn the form uses.
  const fieldErrors = validateRegistration({ email, display_name, password });

  // Invite fields are required and must be non-empty strings (format
  // only — DB lookup happens below). Surface as field errors so the
  // form can show inline messages.
  if (!leagueSlug) {
    fieldErrors.leagueSlug = 'An invite link is required to sign up.';
  }
  if (!inviteCode) {
    fieldErrors.inviteCode = 'An invite code is required.';
  }
  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json({ fieldErrors }, { status: 400 });
  }

  // Validate the invite against the leagues table BEFORE doing any
  // password hashing or DB writes — fail fast on bad invites.
  const league = await db.selectFrom('leagues')
    .select(['id', 'max_players'])
    .where('slug',        '=', leagueSlug)
    .where('invite_code', '=', inviteCode)
    .executeTakeFirst();
  if (!league) {
    return NextResponse.json({
      fieldErrors: { inviteCode: 'Invite link is invalid or the league no longer exists.' },
    }, { status: 403 });
  }

  // Capacity check — the user joins atomically below, so check now.
  const { count } = await db.selectFrom('league_members')
    .select(eb => eb.fn.countAll<string>().as('count'))
    .where('league_id', '=', league.id)
    .executeTakeFirstOrThrow();
  if (Number(count) >= league.max_players) {
    return NextResponse.json({
      fieldErrors: { inviteCode: 'This league is full — ask the commissioner to make room.' },
    }, { status: 403 });
  }

  // Email uniqueness — schema enforces but we surface a friendly
  // error instead of a 500 from the constraint violation.
  const existing = await db.selectFrom('profiles')
    .select('id')
    .where('email', '=', email)
    .executeTakeFirst();
  if (existing) {
    return NextResponse.json({
      fieldErrors: { email: 'An account with that email already exists. Sign in instead?' },
    }, { status: 409 });
  }

  const password_hash = await bcrypt.hash(password, BCRYPT_COST);

  // Invite-flow auto-verification (2026-05-17).
  //
  // Today every registration requires a valid leagueSlug + inviteCode
  // (invite-only signup, P0 hardening). Reaching this point means the
  // caller has demonstrated possession of the league's invite link —
  // which is the same thing every commissioner shares via email,
  // group chat, etc. Trust level: "anyone with the link can join."
  // Forcing a second-factor email-verification step on top of that
  // adds friction without adding security; the invitee already
  // received a usable link to enter the league. Greg's call
  // (2026-05-17): skip the verify gate for these signups, return a
  // flag so the form can auto-sign-in immediately.
  //
  // If a future signup path EVER allows registration without a valid
  // invite, that path must keep generating a verify_token and
  // sending the email — flip `autoVerified` to false there.
  const autoVerified = true;
  const verify_token = autoVerified ? null
    : randomBytes(32).toString('hex');
  const verify_token_expires = autoVerified ? null
    : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // Insert profile + auth_credentials + league_member atomically. If
  // any step fails, the user gets nothing and can retry cleanly.
  try {
    await db.transaction().execute(async tx => {
      const profile = await tx.insertInto('profiles')
        .values({ email, display_name })
        .returning('id')
        .executeTakeFirstOrThrow();

      await tx.insertInto('auth_credentials')
        .values({
          user_id:              profile.id,
          password_hash,
          email_verified:       autoVerified,
          verify_token,
          verify_token_expires,
        })
        .execute();

      await tx.insertInto('league_members')
        .values({
          league_id: league.id,
          user_id:   profile.id,
          role:      'member',
        })
        .execute();
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  // Verification email is skipped on the auto-verified path. Kept the
  // import + helper around so a future non-invite signup path can
  // re-enable it without re-wiring.
  let emailSent = false;
  if (!autoVerified && verify_token) {
    const baseUrl = process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? '';
    const verifyUrl = `${baseUrl}/auth/verify?token=${verify_token}`;
    const { subject, text, html } = verificationEmail({
      displayName: display_name,
      verifyUrl,
    });
    emailSent = await sendEmail({ to: email, subject, text, html });
  }

  return NextResponse.json({ success: true, emailSent, autoVerified });
}
