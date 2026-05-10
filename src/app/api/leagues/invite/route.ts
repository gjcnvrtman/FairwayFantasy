// POST /api/leagues/invite — regenerate the league's invite code.
//
// Commissioner-only. Old code is invalidated immediately.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { generateInviteCode } from '@/lib/db/queries';
import { requireCommissioner, isAuthFail } from '@/lib/auth-league';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const leagueId = typeof body.leagueId === 'string' ? body.leagueId : null;

  const auth = await requireCommissioner({ leagueId });
  if (isAuthFail(auth)) return auth.response;

  const newCode = generateInviteCode();
  try {
    await db.updateTable('leagues')
      .set({ invite_code: newCode })
      .where('id', '=', auth.league.id)
      .execute();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  return NextResponse.json({ inviteCode: newCode });
}
