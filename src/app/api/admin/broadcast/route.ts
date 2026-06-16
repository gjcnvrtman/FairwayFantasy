// POST /api/admin/broadcast — commissioner / co-commissioner sends an
// email to every member of their league.
//
// Body: { slug, subject, body }
//   subject: 1..120 chars (becomes `[<LeagueName>] <subject>`)
//   body:    1..5000 chars, plain text; rendered with paragraphs
//            split on blank lines, single newlines preserved as <br>.
//            No HTML/markdown is honored — what they type is what
//            recipients see.
//
// Auth: co_commissioner or commissioner of the league.
// Rate-limit: max 5 broadcasts per league per 24h. The audit log
//   (`league_broadcasts`) is the lookup target — no need for a
//   separate counter row.
//
// Idempotency: not enforced. A double-click could fire twice. The
// UI uses a confirmation modal + disables the button while in flight,
// which covers normal usage. Audit rows are append-only.

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import { sendEmail, leagueBroadcastEmail } from '@/lib/email';
import { requireCoCommissionerOrAbove, isAuthFail } from '@/lib/auth-league';
import { requireSameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const MAX_PER_24H    = 5;
const SUBJECT_MAX    = 120;
const BODY_MAX       = 5000;
const SITE_URL       = process.env.NEXT_PUBLIC_SITE_URL ?? '';

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const slug         = typeof body.slug    === 'string' ? body.slug.trim()    : null;
  const subjectInput = typeof body.subject === 'string' ? body.subject.trim() : '';
  const bodyInput    = typeof body.body    === 'string' ? body.body.trim()    : '';

  if (!slug) {
    return NextResponse.json({ error: 'slug is required.' }, { status: 400 });
  }

  const fieldErrors: Record<string, string> = {};
  if (subjectInput.length === 0)                 fieldErrors.subject = 'Subject is required.';
  else if (subjectInput.length > SUBJECT_MAX)    fieldErrors.subject = `Subject is too long (max ${SUBJECT_MAX}).`;
  if (bodyInput.length === 0)                    fieldErrors.body    = 'Message body is required.';
  else if (bodyInput.length > BODY_MAX)          fieldErrors.body    = `Message is too long (max ${BODY_MAX}).`;
  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json({ fieldErrors }, { status: 400 });
  }

  // ── Auth ──
  const auth = await requireCoCommissionerOrAbove({ slug });
  if (isAuthFail(auth)) return auth.response;
  const { league } = auth;

  // ── Rate limit: max 5 broadcasts per league per 24h ──
  const recent = await db.selectFrom('league_broadcasts')
    .select(eb => eb.fn.countAll<string>().as('count'))
    .where('league_id', '=', league.id)
    .where('sent_at',   '>', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .executeTakeFirst();
  const recentCount = Number(recent?.count ?? 0);
  if (recentCount >= MAX_PER_24H) {
    return NextResponse.json(
      { error: `Limit reached: max ${MAX_PER_24H} broadcasts per league per 24 hours. Try again later.` },
      { status: 429 },
    );
  }

  // ── Resolve sender display name (for the email signature) ──
  const sender = await db.selectFrom('profiles')
    .select(['display_name'])
    .where('id', '=', user.id)
    .executeTakeFirst();
  const fromName = sender?.display_name?.trim() || 'Your commissioner';

  // ── Pull all league members with their email + display_name ──
  const members = await db.selectFrom('league_members')
    .innerJoin('profiles', 'profiles.id', 'league_members.user_id')
    .select(['profiles.id', 'profiles.email', 'profiles.display_name'])
    .where('league_members.league_id', '=', league.id)
    .execute();

  // ── Send ──
  let sent = 0, failed = 0;
  const failures: string[] = [];
  for (const m of members) {
    if (!m.email) { failed++; continue; }
    const rendered = leagueBroadcastEmail({
      recipientName: m.display_name?.trim() || 'Player',
      leagueName:    league.name,
      leagueSlug:    league.slug,
      fromName,
      subject:       subjectInput,
      body:          bodyInput,
      siteUrl:       SITE_URL,
    });
    try {
      const ok = await sendEmail({
        to:      m.email,
        subject: rendered.subject,
        text:    rendered.text,
        html:    rendered.html,
      });
      if (ok) sent++;
      else   { failed++; failures.push(m.email); }
    } catch (err) {
      failed++;
      failures.push(`${m.email}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Audit row (always written, even if some sends failed) ──
  await db.insertInto('league_broadcasts')
    .values({
      league_id:        league.id,
      sender_user_id:   user.id,
      subject:          subjectInput,
      body:             bodyInput,
      recipient_count:  sent,
    })
    .execute();

  return NextResponse.json({
    success:  failed === 0,
    sent,
    failed,
    failures: failures.length > 0 ? failures : undefined,
    remaining_today: MAX_PER_24H - recentCount - 1,
  });
}
