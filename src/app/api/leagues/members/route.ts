// DELETE /api/leagues/members?leagueId=…&userId=…
//
// Commissioner-only. Removes a member from the league. Guards
// against last-commissioner removal so the league can't be orphaned.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireCommissioner, isAuthFail, wouldOrphanLeague, type Role } from '@/lib/auth-league';

export async function DELETE(req: NextRequest) {
  const leagueId = req.nextUrl.searchParams.get('leagueId');
  const userId   = req.nextUrl.searchParams.get('userId');

  // ── Auth: commissioner of the named league ──
  const auth = await requireCommissioner({ leagueId });
  if (isAuthFail(auth)) return auth.response;

  if (!userId || typeof userId !== 'string') {
    return NextResponse.json(
      { error: 'Missing userId parameter.' },
      { status: 400 },
    );
  }

  // ── Last-commissioner guard ──
  // Fetch current membership snapshot. If removing this user would
  // leave the league with zero commissioners, block the request.
  const members = await db.selectFrom('league_members')
    .select(['user_id', 'role'])
    .where('league_id', '=', auth.league.id)
    .execute();

  if (wouldOrphanLeague({
    members: members as Array<{ user_id: string; role: Role }>,
    removeUserId: userId,
  })) {
    return NextResponse.json(
      {
        error:
          'You can\'t remove the last commissioner. Promote another member to commissioner first, ' +
          'or delete the league entirely.',
      },
      { status: 409 },
    );
  }

  try {
    await db.deleteFrom('league_members')
      .where('league_id', '=', auth.league.id)
      .where('user_id', '=', userId)
      .execute();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
