// /api/leagues/invite-by-email — send the league invite link to one
// or more email addresses via SMTP.
//
// POST { slug, emails: string[] }
//   - slug authenticates the caller as a member (commissioner OR
//     rank-and-file) of the league. Same security level as the
//     existing copy-link button: anyone in the league can forward
//     the invite, this just routes it through our SMTP instead of
//     the user's own mail client.
//   - emails: trimmed/lowercased/deduped. Hard cap of MAX_EMAILS per
//     request so a single click can't fan out to thousands.
//
// Rate-limited per-IP (8 / 10 min) so a malicious member can't burn
// through Gmail's daily send budget. Each email send is logged with
// a boolean ok/fail; the route returns a per-address summary so the
// UI can show which addresses got through and which didn't.
//
// Returns 200 with { ok, sent: [...], failed: [...] }.

import { NextRequest, NextResponse } from 'next/server';
import { requireMember, isAuthFail } from '@/lib/auth-league';
import { db } from '@/lib/db';
import { checkRateLimit, clientIpFromHeaders } from '@/lib/rate-limit';
import { sendEmail, invitationEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

// Per-IP cap on invite-send. Higher than /api/auth/register because a
// commissioner legitimately may want to fan out to all their buddies
// at once on league-creation day, but still low enough to make a
// scripted attack visible quickly.
const RL_LIMIT  = 8;
const RL_WINDOW = 600;

// Hard cap on emails per single request. Anything beyond this is
// almost certainly spam — and Gmail will rate-limit our app password
// regardless, so capping here gives a clean error instead of a slow
// timeout.
const MAX_EMAILS = 20;

// RFC-pragmatic email regex. Not a parser — just rejects obvious
// garbage (no @, no domain, whitespace, etc.).
const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  const ip = clientIpFromHeaders(req.headers);
  const rl = await checkRateLimit({
    key:           `invite-by-email:${ip}`,
    limit:         RL_LIMIT,
    windowSeconds: RL_WINDOW,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many invite emails. Try again in a few minutes.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds) } },
    );
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const slug = typeof body.slug === 'string' ? body.slug : '';
  const rawEmails = Array.isArray(body.emails) ? body.emails : null;

  if (!rawEmails) {
    return NextResponse.json(
      { error: 'emails must be an array of strings.' },
      { status: 400 },
    );
  }

  // Normalise: trim, lowercase, dedupe.
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of rawEmails) {
    if (typeof raw !== 'string') continue;
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    if (seen.has(e)) continue;
    seen.add(e);
    candidates.push(e);
  }

  if (candidates.length === 0) {
    return NextResponse.json(
      { error: 'No email addresses provided.' },
      { status: 400 },
    );
  }
  if (candidates.length > MAX_EMAILS) {
    return NextResponse.json(
      { error: `Too many addresses in one request — max ${MAX_EMAILS}.` },
      { status: 400 },
    );
  }

  // Bucket malformed addresses so the UI can show them as failures
  // without taking a round-trip through nodemailer.
  const valid:   string[]                           = [];
  const failed:  Array<{ email: string; reason: string }> = [];
  for (const e of candidates) {
    if (EMAIL_RE.test(e)) valid.push(e);
    else                  failed.push({ email: e, reason: 'invalid format' });
  }

  // Auth — must be a member (any role) of the league.
  const auth = await requireMember({ slug });
  if (isAuthFail(auth)) return auth.response;

  // Inviter's display name for the email subject + body. Fall back
  // gracefully so the email still ships if the profile row is bare.
  const profile = await db.selectFrom('profiles')
    .select(['display_name', 'email'])
    .where('id', '=', auth.user.id)
    .executeTakeFirst();
  const inviterName = profile?.display_name || profile?.email || 'A Fairway Fantasy member';

  const siteUrl    = process.env.NEXT_PUBLIC_SITE_URL || '';
  const inviteBase = `${siteUrl}/join/${auth.league.slug}/${auth.league.invite_code}`;

  // Sequential — Gmail SMTP is fine with a handful of sends in a row
  // and we want per-address failure attribution. Parallelising via
  // Promise.all would conflate errors. MAX_EMAILS keeps the loop bounded.
  //
  // Each recipient gets a URL with their own ?email= param so the
  // /join page can redirect logged-out users straight to a signup
  // form with the email pre-filled. Anyone who copy-pastes the link
  // can still edit the field — the param is a hint, not a credential.
  const sent: string[] = [];
  for (const to of valid) {
    const inviteUrl = `${inviteBase}?email=${encodeURIComponent(to)}`;
    const { subject, text, html } = invitationEmail({
      leagueName:  auth.league.name,
      inviterName,
      inviteUrl,
    });
    const ok = await sendEmail({ to, subject, text, html });
    if (ok) sent.push(to);
    else    failed.push({ email: to, reason: 'SMTP send failed' });
  }

  return NextResponse.json({
    ok: true,
    sent,
    failed,
    inviteUrl: inviteBase,   // echoed so the UI can still show the canonical link
  });
}
