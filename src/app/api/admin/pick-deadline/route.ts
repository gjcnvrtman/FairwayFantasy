// /api/admin/pick-deadline — commissioner sets or clears the
// per-tournament pick-deadline override (P1).
//
// POST { slug, tournamentId, deadline?: ISO-8601 string | null }
//   - slug authenticates the requester as a commissioner of that league
//   - tournamentId is global; the override affects all leagues since
//     pick_deadline_override lives on `tournaments`, not per-league
//   - deadline=null (or omitted) clears the override → falls back to
//     the auto-computed pick_deadline (start_date - 1h)
//
// Returns 200 with { ok, effective_deadline }.

import { NextRequest, NextResponse } from 'next/server';
import { requireCommissioner, isAuthFail } from '@/lib/auth-league';
import { db } from '@/lib/db';
import { effectivePickDeadline } from '@/lib/pick-deadline';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body  = await req.json().catch(() => ({} as Record<string, unknown>));
  const slug          = typeof body.slug          === 'string' ? body.slug          : '';
  const tournamentId  = typeof body.tournamentId  === 'string' ? body.tournamentId  : '';
  const deadlineInput =
    typeof body.deadline === 'string'    ? body.deadline :
    body.deadline === null               ? null :
    /* undefined */                        null;

  if (!tournamentId) {
    return NextResponse.json({ error: 'tournamentId is required.' }, { status: 400 });
  }

  const auth = await requireCommissioner({ slug });
  if (isAuthFail(auth)) return auth.response;

  // Parse the deadline string. If invalid (and not null), reject.
  let deadline: Date | null = null;
  if (deadlineInput !== null) {
    const parsed = new Date(deadlineInput);
    if (isNaN(parsed.getTime())) {
      return NextResponse.json(
        { error: 'Invalid deadline format. Expected an ISO-8601 string or null.' },
        { status: 400 },
      );
    }
    deadline = parsed;
  }

  // Verify the tournament exists before writing.
  const t = await db.selectFrom('tournaments')
    .select(['id', 'name', 'pick_deadline'])
    .where('id', '=', tournamentId)
    .executeTakeFirst();
  if (!t) return NextResponse.json({ error: 'Tournament not found.' }, { status: 404 });

  await db.updateTable('tournaments')
    .set({ pick_deadline_override: deadline ? deadline.toISOString() : null })
    .where('id', '=', tournamentId)
    .execute();

  // Re-fetch to compute the effective deadline that callers should
  // display going forward.
  const updated = await db.selectFrom('tournaments')
    .select(['pick_deadline', 'pick_deadline_override'])
    .where('id', '=', tournamentId)
    .executeTakeFirstOrThrow();

  return NextResponse.json({
    ok: true,
    tournament: { id: tournamentId, name: t.name },
    pick_deadline:           updated.pick_deadline,
    pick_deadline_override:  updated.pick_deadline_override,
    effective_deadline:      effectivePickDeadline(updated)?.toISOString() ?? null,
  });
}
