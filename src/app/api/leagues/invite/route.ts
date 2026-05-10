// POST /api/leagues/invite — regenerate the league's invite code.
//
// Commissioner-only. Old code is invalidated immediately.

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, generateInviteCode } from '@/lib/supabase';
import { requireCommissioner, isAuthFail } from '@/lib/auth-league';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const leagueId = typeof body.leagueId === 'string' ? body.leagueId : null;

  const auth = await requireCommissioner({ leagueId });
  if (isAuthFail(auth)) return auth.response;

  const newCode = generateInviteCode();
  const { error } = await supabaseAdmin
    .from('leagues')
    .update({ invite_code: newCode })
    .eq('id', auth.league.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ inviteCode: newCode });
}
