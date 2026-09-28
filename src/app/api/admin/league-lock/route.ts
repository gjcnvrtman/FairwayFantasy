// /api/admin/league-lock — commissioner freezes a setup-mode league.
//
// POST { slug }
//   - Commissioner only (co-commissioners can't lock).
//   - League must be in setup mode (migration 025). Legacy leagues
//     never lock; an already-locked league returns 409.
//   - Refuses to lock an empty schedule — there'd be nothing to play.
//
// After locking, bets, payout split, penalties, date window and
// schedule are read-only for good. See src/lib/league-setup.ts.

import { NextRequest, NextResponse } from 'next/server';
import { requireCommissioner, isAuthFail } from '@/lib/auth-league';
import { requireSameOrigin } from '@/lib/same-origin';
import { resolveSetupStatus } from '@/lib/league-setup';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const slug = typeof body.slug === 'string' ? body.slug : '';

  const auth = await requireCommissioner({ slug });
  if (isAuthFail(auth)) return auth.response;

  const status = await resolveSetupStatus(auth.league);
  if (status === 'legacy') {
    return NextResponse.json(
      { error: 'This league predates league setup and doesn’t use a setup lock.' },
      { status: 400 },
    );
  }
  if (status === 'locked') {
    return NextResponse.json({ error: 'League setup is already locked.' }, { status: 409 });
  }

  const scheduled = await db.selectFrom('league_tournaments')
    .select(eb => eb.fn.countAll<string>().as('n'))
    .where('league_id', '=', auth.league.id)
    .executeTakeFirstOrThrow();
  if (Number(scheduled.n) === 0) {
    return NextResponse.json(
      { error: 'Add at least one tournament to the schedule before locking.' },
      { status: 400 },
    );
  }

  await db.updateTable('leagues')
    .set({ setup_status: 'locked', setup_locked_at: new Date().toISOString() })
    .where('id', '=', auth.league.id)
    .where('setup_status', '=', 'setup')
    .execute();

  // eslint-disable-next-line no-console
  console.log(`[league-setup] locked by commissioner league=${auth.league.slug} user=${auth.user.id}`);
  return NextResponse.json({ ok: true });
}
