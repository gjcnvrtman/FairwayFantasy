// /api/admin/league-roles — commissioner-only role assignment.
//
// POST { slug, userId, role: 'member' | 'co_commissioner' }
//
//   * slug authenticates as a commissioner of THIS league.
//   * userId must be an existing member of the league (not self).
//   * role accepts only 'member' or 'co_commissioner'. The
//     'commissioner' role can only be set via league creation —
//     promoting someone to full commissioner is intentionally
//     NOT exposed here (would create a "two captains" situation
//     that the wouldOrphanLeague guard doesn't model).
//   * Refuses to modify a row that's currently 'commissioner' —
//     the original commissioner is fixed at creation. Demoting
//     a commissioner is intentionally not exposed; if the
//     commissioner wants out, they delete the league or
//     resign-with-handoff via a future migration.
//
// Co-commissioners can do operational work but cannot change
// roles. Same `requireCommissioner` gate as league-delete /
// league-settings.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireCommissioner, isAuthFail, type Role } from '@/lib/auth-league';
import { requireSameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const ASSIGNABLE_ROLES: ReadonlyArray<Role> = ['member', 'co_commissioner'];

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const slug   = typeof body.slug   === 'string' ? body.slug   : '';
  const userId = typeof body.userId === 'string' ? body.userId : '';
  const role   = typeof body.role   === 'string' ? body.role   : '';

  if (!slug || !userId) {
    return NextResponse.json(
      { error: 'slug and userId are required.' },
      { status: 400 },
    );
  }

  if (!ASSIGNABLE_ROLES.includes(role as Role)) {
    return NextResponse.json(
      { error: `role must be one of: ${ASSIGNABLE_ROLES.join(', ')}.` },
      { status: 400 },
    );
  }

  const auth = await requireCommissioner({ slug });
  if (isAuthFail(auth)) return auth.response;

  if (userId === auth.user.id) {
    return NextResponse.json(
      { error: 'You can\'t change your own role.' },
      { status: 400 },
    );
  }

  // Confirm target user is a member; capture current role for the
  // "don't touch commissioners" guard.
  const target = await db.selectFrom('league_members')
    .select(['user_id', 'role'])
    .where('league_id', '=', auth.league.id)
    .where('user_id',   '=', userId)
    .executeTakeFirst();

  if (!target) {
    return NextResponse.json(
      { error: 'That user is not a member of this league.' },
      { status: 404 },
    );
  }

  if (target.role === 'commissioner') {
    return NextResponse.json(
      { error: 'The league commissioner\'s role can\'t be changed here.' },
      { status: 409 },
    );
  }

  if (target.role === role) {
    // No-op — return success without writing so the UI's "no change"
    // case doesn't bump updated_at or generate misleading audit log.
    return NextResponse.json({ ok: true, unchanged: true });
  }

  try {
    await db.updateTable('league_members')
      .set({ role })
      .where('league_id', '=', auth.league.id)
      .where('user_id',   '=', userId)
      .execute();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
