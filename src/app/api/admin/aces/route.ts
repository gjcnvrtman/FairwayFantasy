// /api/admin/aces — commissioner corrections for the hole-in-one
// bounty (migration 027). ESPN per-hole data can be incomplete, so
// aces are auto-detected but correctable per league.
//
// POST   { slug, tournamentId, golferId, round, hole, action: 'add'|'void' }
//          'add'  — credit an ace the data missed
//          'void' — remove an auto-detected ace
// DELETE { slug, tournamentId, golferId, round, hole }
//          remove the correction (back to what the data says)
//
// Allowed after setup lock — this corrects data, not rules.

import { NextRequest, NextResponse } from 'next/server';
import { requireCoCommissionerOrAbove, isAuthFail } from '@/lib/auth-league';
import { requireSameOrigin } from '@/lib/same-origin';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

async function parse(req: NextRequest) {
  const b = await req.json().catch(() => ({} as Record<string, unknown>));
  return {
    slug:         typeof b.slug === 'string' ? b.slug : '',
    tournamentId: typeof b.tournamentId === 'string' ? b.tournamentId : '',
    golferId:     typeof b.golferId === 'string' ? b.golferId : '',
    round:        Number(b.round),
    hole:         Number(b.hole),
    action:       b.action,
  };
}

async function authorize(req: NextRequest, slug: string, tournamentId: string) {
  const csrf = requireSameOrigin(req);
  if (csrf) return { error: csrf };
  const auth = await requireCoCommissionerOrAbove({ slug });
  if (isAuthFail(auth)) return { error: auth.response };
  if (auth.league.bet_ace_bounty == null) {
    return { error: NextResponse.json({ error: 'This league has no hole-in-one bounty.' }, { status: 400 }) };
  }
  const scheduled = await db.selectFrom('league_tournaments')
    .select('tournament_id')
    .where('league_id', '=', auth.league.id)
    .where('tournament_id', '=', tournamentId)
    .executeTakeFirst();
  if (!scheduled) {
    return { error: NextResponse.json({ error: 'Tournament is not on this league’s schedule.' }, { status: 404 }) };
  }
  return { auth };
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const p = await parse(req);
  if (p.action !== 'add' && p.action !== 'void') {
    return NextResponse.json({ error: 'action must be "add" or "void".' }, { status: 400 });
  }
  if (!Number.isInteger(p.round) || p.round < 1 || p.round > 4 ||
      !Number.isInteger(p.hole)  || p.hole  < 1 || p.hole  > 18) {
    return NextResponse.json({ error: 'Round must be 1–4 and hole 1–18.' }, { status: 400 });
  }
  const r = await authorize(req, p.slug, p.tournamentId);
  if ('error' in r) return r.error;

  const inField = await db.selectFrom('scores')
    .select('golfer_id')
    .where('tournament_id', '=', p.tournamentId)
    .where('golfer_id', '=', p.golferId)
    .executeTakeFirst();
  if (!inField) {
    return NextResponse.json({ error: 'That golfer isn’t in this tournament’s field.' }, { status: 400 });
  }

  await db.insertInto('league_ace_adjustments')
    .values({
      league_id: r.auth.league.id, tournament_id: p.tournamentId, golfer_id: p.golferId,
      round_num: p.round, hole_num: p.hole, action: p.action, created_by: user.id,
    })
    .onConflict(oc => oc
      .columns(['league_id', 'tournament_id', 'golfer_id', 'round_num', 'hole_num'])
      .doUpdateSet({ action: p.action, created_by: user.id }))
    .execute();
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const p = await parse(req);
  const r = await authorize(req, p.slug, p.tournamentId);
  if ('error' in r) return r.error;
  await db.deleteFrom('league_ace_adjustments')
    .where('league_id', '=', r.auth.league.id)
    .where('tournament_id', '=', p.tournamentId)
    .where('golfer_id', '=', p.golferId)
    .where('round_num', '=', p.round)
    .where('hole_num', '=', p.hole)
    .execute();
  return NextResponse.json({ ok: true });
}
