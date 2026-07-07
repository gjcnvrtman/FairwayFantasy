// /api/admin/schedule — commissioner / co-commissioner adds a
// tournament to this league's schedule or removes one from it
// (migration 022).
//
// POST   { slug, tournamentId }  → adds (idempotent via ON CONFLICT)
// DELETE { slug, tournamentId }  → removes if the league has NOT yet
//                                  submitted any picks for it and no
//                                  fantasy_results rows exist. Blocks
//                                  otherwise so historical scoring
//                                  data doesn't dangle.
//
// The tournaments row itself is global and never deleted or touched
// here — only the (league_id, tournament_id) join row is affected.

import { NextRequest, NextResponse } from 'next/server';
import { requireCoCommissionerOrAbove, isAuthFail } from '@/lib/auth-league';
import { requireSameOrigin } from '@/lib/same-origin';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

async function parseBody(req: NextRequest) {
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const slug         = typeof body.slug         === 'string' ? body.slug         : '';
  const tournamentId = typeof body.tournamentId === 'string' ? body.tournamentId : '';
  return { slug, tournamentId };
}

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { slug, tournamentId } = await parseBody(req);
  if (!tournamentId) {
    return NextResponse.json({ error: 'tournamentId is required.' }, { status: 400 });
  }

  const auth = await requireCoCommissionerOrAbove({ slug });
  if (isAuthFail(auth)) return auth.response;

  // Refuse to add a hidden tournament — hidden means "we've decided
  // this event doesn't belong on anyone's schedule." Commissioner can
  // unhide it globally if they truly want it (out of scope for this
  // endpoint).
  const t = await db.selectFrom('tournaments')
    .select(['id', 'name', 'hidden'])
    .where('id', '=', tournamentId)
    .executeTakeFirst();
  if (!t) return NextResponse.json({ error: 'Tournament not found.' }, { status: 404 });
  if (t.hidden) {
    return NextResponse.json(
      { error: `"${t.name}" is hidden globally and can't be added to a league schedule.` },
      { status: 409 },
    );
  }

  await db.insertInto('league_tournaments')
    .values({
      league_id:     auth.league.id,
      tournament_id: tournamentId,
      added_by:      user.id,
    })
    .onConflict(oc => oc.doNothing())
    .execute();

  return NextResponse.json({ ok: true, tournament: { id: t.id, name: t.name } });
}

export async function DELETE(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { slug, tournamentId } = await parseBody(req);
  if (!tournamentId) {
    return NextResponse.json({ error: 'tournamentId is required.' }, { status: 400 });
  }

  const auth = await requireCoCommissionerOrAbove({ slug });
  if (isAuthFail(auth)) return auth.response;

  // Block the delete if picks or fantasy_results already exist for
  // this (league, tournament). Removing the join row wouldn't cascade
  // to picks/scores, but the schedule tab would stop showing the
  // event and history math would lose an entry — silent data
  // disappearance. Force the commissioner to acknowledge.
  const pickCount = await db.selectFrom('picks')
    .select(eb => eb.fn.countAll<string>().as('n'))
    .where('league_id', '=', auth.league.id)
    .where('tournament_id', '=', tournamentId)
    .executeTakeFirstOrThrow();
  const resultCount = await db.selectFrom('fantasy_results')
    .select(eb => eb.fn.countAll<string>().as('n'))
    .where('league_id', '=', auth.league.id)
    .where('tournament_id', '=', tournamentId)
    .executeTakeFirstOrThrow();

  const picks   = Number(pickCount.n);
  const results = Number(resultCount.n);
  if (picks > 0 || results > 0) {
    return NextResponse.json(
      {
        error: `Cannot remove — this league already has ${picks} pick(s) and `
             + `${results} result(s) for that tournament. Removing it would `
             + `hide historical data. Contact the site admin if you truly `
             + `need to wipe it.`,
      },
      { status: 409 },
    );
  }

  await db.deleteFrom('league_tournaments')
    .where('league_id', '=', auth.league.id)
    .where('tournament_id', '=', tournamentId)
    .execute();

  return NextResponse.json({ ok: true });
}
