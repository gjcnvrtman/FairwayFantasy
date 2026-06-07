// /api/leagues/[slug]/messages — per-tournament smack board.
//
//   GET  ?tournamentId=<uuid>  — list newest-first, MESSAGE_LIMITS.PAGE_SIZE
//   POST { tournamentId, body } — create
//
// Auth: any league member. Same-origin CSRF on POST.
// Rate limit on POST: 20 messages / 10 min / (user, league).
//
// Each row in the GET response includes ``canDelete`` (true if the
// viewer is the author OR a commissioner/co_commissioner of this
// league) so the client doesn't have to recompute the rule.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireMember, isAuthFail } from '@/lib/auth-league';
import { requireSameOrigin } from '@/lib/same-origin';
import { checkRateLimit } from '@/lib/rate-limit';
import { validateMessageBody, MESSAGE_LIMITS, type MessageView } from '@/lib/messages';

export const dynamic = 'force-dynamic';

// ─────────────────────────────────────────────────────────────
// GET — list messages for one (league, tournament)
// ─────────────────────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: { slug: string } },
) {
  const auth = await requireMember({ slug: params.slug });
  if (isAuthFail(auth)) return auth.response;

  const tournamentId = req.nextUrl.searchParams.get('tournamentId');
  if (!tournamentId) {
    return NextResponse.json(
      { error: 'Missing tournamentId parameter.' },
      { status: 400 },
    );
  }

  // Join to profiles for the author display_name. Newest-first; cap
  // at PAGE_SIZE. We do NOT validate the tournamentId exists — a
  // stale/bogus id just returns an empty list, which is fine.
  const rows = await db.selectFrom('league_messages as m')
    .innerJoin('profiles as p', 'p.id', 'm.user_id')
    .select([
      'm.id',
      'm.user_id',
      'm.body',
      'm.created_at',
      'p.display_name',
    ])
    .where('m.league_id',     '=', auth.league.id)
    .where('m.tournament_id', '=', tournamentId)
    .orderBy('m.created_at', 'desc')
    .limit(MESSAGE_LIMITS.PAGE_SIZE)
    .execute();

  const canModerate = auth.role === 'commissioner' || auth.role === 'co_commissioner';

  const messages: MessageView[] = rows.map(r => ({
    id:           r.id,
    user_id:      r.user_id,
    display_name: r.display_name,
    body:         r.body,
    created_at:   typeof r.created_at === 'string' ? r.created_at : new Date(r.created_at).toISOString(),
    canDelete:    canModerate || r.user_id === auth.user.id,
  }));

  return NextResponse.json({ messages });
}

// ─────────────────────────────────────────────────────────────
// POST — author a new message
// ─────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: { slug: string } },
) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const auth = await requireMember({ slug: params.slug });
  if (isAuthFail(auth)) return auth.response;

  // ── Body parse + validate ─────────────────────────────────
  const json = await req.json().catch(() => ({} as Record<string, unknown>));
  const tournamentId = typeof json.tournamentId === 'string' ? json.tournamentId : '';
  const rawBody      = typeof json.body          === 'string' ? json.body          : '';
  const body         = rawBody.trim();

  if (!tournamentId) {
    return NextResponse.json(
      { error: 'Missing tournamentId.' },
      { status: 400 },
    );
  }

  const bodyError = validateMessageBody(body);
  if (bodyError) {
    return NextResponse.json(
      { fieldErrors: { body: bodyError } },
      { status: 400 },
    );
  }

  // ── Rate limit (per user × league) ────────────────────────
  // Keyed on user + league so a single user spamming league A can't
  // accidentally throttle their own posts in league B.
  const limit = await checkRateLimit({
    key:           `smack:${auth.user.id}:${auth.league.id}`,
    limit:         MESSAGE_LIMITS.POST_LIMIT,
    windowSeconds: MESSAGE_LIMITS.POST_WINDOW_SECONDS,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'You\'re posting too fast. Take a breath, then try again.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  // ── Tournament exists? ────────────────────────────────────
  // Soft check — we don't want to allow posting against a totally
  // bogus tournament id (FK would catch it but the 500 reads ugly).
  const tournament = await db.selectFrom('tournaments')
    .select('id')
    .where('id', '=', tournamentId)
    .executeTakeFirst();
  if (!tournament) {
    return NextResponse.json(
      { error: 'Tournament not found.' },
      { status: 404 },
    );
  }

  // ── Insert ────────────────────────────────────────────────
  let inserted;
  try {
    inserted = await db.insertInto('league_messages')
      .values({
        league_id:     auth.league.id,
        tournament_id: tournamentId,
        user_id:       auth.user.id,
        body,
      })
      .returning(['id', 'created_at'])
      .executeTakeFirstOrThrow();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  // Pull the author's display_name so the client can render the
  // newly-posted row without re-fetching the whole thread.
  const profile = await db.selectFrom('profiles')
    .select('display_name')
    .where('id', '=', auth.user.id)
    .executeTakeFirst();

  const message: MessageView = {
    id:           inserted.id,
    user_id:      auth.user.id,
    display_name: profile?.display_name ?? 'Player',
    body,
    created_at:   typeof inserted.created_at === 'string'
                    ? inserted.created_at
                    : new Date(inserted.created_at).toISOString(),
    canDelete:    true,
  };

  return NextResponse.json({ message });
}
