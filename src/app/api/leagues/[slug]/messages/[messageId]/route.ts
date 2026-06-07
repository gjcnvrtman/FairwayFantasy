// /api/leagues/[slug]/messages/[messageId] — delete one smack-board
// message. Hard delete, no audit trail (the board resets per
// tournament anyway).
//
// Auth: league member. The row itself must satisfy one of:
//   * viewer is the message author
//   * viewer is the league's commissioner OR co_commissioner
//
// 403 otherwise. 404 if the row doesn't exist or belongs to a
// different league than the slug — we conflate the two so a viewer
// can't probe other leagues' message ids.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireMember, isAuthFail } from '@/lib/auth-league';
import { requireSameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

export async function DELETE(
  req: NextRequest,
  { params }: { params: { slug: string; messageId: string } },
) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const auth = await requireMember({ slug: params.slug });
  if (isAuthFail(auth)) return auth.response;

  if (!params.messageId) {
    return NextResponse.json(
      { error: 'Missing messageId.' },
      { status: 400 },
    );
  }

  // Pull the row scoped to THIS league so a cross-league delete attempt
  // is indistinguishable from a not-found.
  const row = await db.selectFrom('league_messages')
    .select(['id', 'user_id'])
    .where('id',        '=', params.messageId)
    .where('league_id', '=', auth.league.id)
    .executeTakeFirst();

  if (!row) {
    return NextResponse.json({ error: 'Message not found.' }, { status: 404 });
  }

  const isAuthor    = row.user_id === auth.user.id;
  const canModerate = auth.role === 'commissioner' || auth.role === 'co_commissioner';

  if (!isAuthor && !canModerate) {
    return NextResponse.json(
      { error: 'You can only delete your own messages.' },
      { status: 403 },
    );
  }

  try {
    await db.deleteFrom('league_messages')
      .where('id',        '=', params.messageId)
      .where('league_id', '=', auth.league.id)
      .execute();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
