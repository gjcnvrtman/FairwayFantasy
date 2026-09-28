// /api/admin/schedule-import — pull the ESPN calendar again and add
// every event in the league's date window that isn't already on its
// schedule. Setup-mode leagues only (migration 025).
//
// POST { slug }
//
// Why this exists: a league created before ESPN publishes next
// season's calendar seeds an empty schedule. This lets the
// commissioner fill it in later. Note it re-adds any in-window event
// the commissioner removed earlier — the UI says so.

import { NextRequest, NextResponse } from 'next/server';
import { requireCoCommissionerOrAbove, isAuthFail } from '@/lib/auth-league';
import { requireSameOrigin } from '@/lib/same-origin';
import { getCurrentUser } from '@/lib/current-user';
import { resolveSetupStatus } from '@/lib/league-setup';
import { importPGAScheduleFromESPN } from '@/lib/schedule-import';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const slug = typeof body.slug === 'string' ? body.slug : '';

  const auth = await requireCoCommissionerOrAbove({ slug });
  if (isAuthFail(auth)) return auth.response;

  if (await resolveSetupStatus(auth.league) !== 'setup') {
    return NextResponse.json(
      { error: 'The ESPN calendar can only be imported while the league is in setup mode.' },
      { status: 409 },
    );
  }

  try {
    await importPGAScheduleFromESPN();
  } catch (err) {
    return NextResponse.json(
      { error: `ESPN import failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  const league = auth.league;
  const added = await db.insertInto('league_tournaments')
    .columns(['league_id', 'tournament_id', 'added_by'])
    .expression(eb => eb
      .selectFrom('tournaments')
      .select(eb2 => [
        eb2.val(league.id).as('league_id'),
        'tournaments.id as tournament_id',
        eb2.val(user.id).as('added_by'),
      ])
      .where('tournaments.hidden', '=', false)
      .$if(!!league.start_date, qb =>
        qb.where('tournaments.start_date', '>=', new Date(league.start_date!).toISOString()))
      .$if(!!league.end_date, qb =>
        qb.where('tournaments.start_date', '<=', new Date(league.end_date!).toISOString())),
    )
    .onConflict(oc => oc.doNothing())
    .returning('tournament_id')
    .execute();

  return NextResponse.json({ ok: true, added: added.length });
}
