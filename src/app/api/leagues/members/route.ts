// DELETE /api/leagues/members?leagueId=…&userId=…
//
// Commissioner-or-above. Removes a member from the league.
//
// Authorization rules (2026-05-20 — co-commissioner role added):
//   * Caller must be commissioner OR co_commissioner of the league.
//   * Co-commissioners CANNOT remove a commissioner or another
//     co_commissioner. Only a full commissioner can do that.
//   * Last-commissioner guard still applies (counts only role=
//     'commissioner', not co's) — removing the sole commissioner
//     would orphan the league.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  requireCoCommissionerOrAbove,
  isAuthFail,
  wouldOrphanLeague,
  type Role,
} from '@/lib/auth-league';
import { requireSameOrigin } from '@/lib/same-origin';

export async function DELETE(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const leagueId = req.nextUrl.searchParams.get('leagueId');
  const userId   = req.nextUrl.searchParams.get('userId');

  // ── Auth: commissioner or co-commissioner of the named league ──
  const auth = await requireCoCommissionerOrAbove({ leagueId });
  if (isAuthFail(auth)) return auth.response;

  if (!userId || typeof userId !== 'string') {
    return NextResponse.json(
      { error: 'Missing userId parameter.' },
      { status: 400 },
    );
  }

  // ── Membership snapshot — used for both target-role check and
  // last-commissioner guard. One query, fetched once.
  const members = await db.selectFrom('league_members')
    .select(['user_id', 'role'])
    .where('league_id', '=', auth.league.id)
    .execute();

  // ── Co-commissioner cannot demote/remove a commissioner OR a
  // fellow co_commissioner. Stops a co from going rogue.
  if (auth.role === 'co_commissioner') {
    const target = members.find(m => m.user_id === userId);
    if (target && (target.role === 'commissioner' || target.role === 'co_commissioner')) {
      return NextResponse.json(
        { error: 'Co-commissioners cannot remove a commissioner or another co-commissioner.' },
        { status: 403 },
      );
    }
  }

  // ── Last-commissioner guard ──
  // Counts only role='commissioner' (co_commissioner doesn't satisfy);
  // a league with 0 commissioners + N co's is functionally orphaned
  // because co's cannot promote new commissioners.
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
