// /api/admin/member-name — commissioner / co-commissioner edit of
// another member's first + last name. Added 2026-06-12 so admins can
// clean up typos / blanks left over from signup without having to ask
// the user to do it themselves.
//
// POST { slug, userId, first_name, last_name }
//
//   * slug authenticates as a commissioner OR co_commissioner of THIS
//     league (`requireCoCommissionerOrAbove`). The target user must be
//     a current member of the same league — admins can't edit names
//     across leagues, even when the user is in both.
//   * first_name / last_name: trimmed strings. Empty string → NULL in
//     the DB (clears the field). At least one of the two must be
//     present in the body — sending neither is a 400.
//
// Why first+last only (not display_name): display_name is owned by
// the user (their handle), and admins shouldn't be able to rewrite it.
// first_name + last_name are identifying real-world data the league
// commish needs accurate for the leaderboard, money tracking, and
// emails. Different intent → different endpoint.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireCoCommissionerOrAbove, isAuthFail } from '@/lib/auth-league';
import { validateName, AUTH_LIMITS } from '@/lib/auth-validation';
import { requireSameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const slug   = typeof body.slug   === 'string' ? body.slug   : '';
  const userId = typeof body.userId === 'string' ? body.userId : '';

  if (!slug || !userId) {
    return NextResponse.json(
      { error: 'slug and userId are required.' },
      { status: 400 },
    );
  }

  const hasFirst = body.first_name !== undefined;
  const hasLast  = body.last_name  !== undefined;
  if (!hasFirst && !hasLast) {
    return NextResponse.json(
      { error: 'Provide first_name and/or last_name.' },
      { status: 400 },
    );
  }

  const auth = await requireCoCommissionerOrAbove({ slug });
  if (isAuthFail(auth)) return auth.response;

  // Target must be a member of the league the admin is acting on.
  // Without this an admin of league A could overwrite the name of a
  // user who's only in league B — the slug check above gates the
  // verb, not the object.
  const target = await db.selectFrom('league_members')
    .select('user_id')
    .where('league_id', '=', auth.league.id)
    .where('user_id',   '=', userId)
    .executeTakeFirst();
  if (!target) {
    return NextResponse.json(
      { error: 'That user is not a member of this league.' },
      { status: 404 },
    );
  }

  const fieldErrors: Record<string, string> = {};
  const updates: { first_name?: string | null; last_name?: string | null } = {};

  if (hasFirst) {
    const raw = typeof body.first_name === 'string' ? body.first_name.trim() : '';
    if (raw === '') {
      updates.first_name = null;
    } else if (raw.length > AUTH_LIMITS.NAME_MAX) {
      const err = validateName(raw, 'First name');
      if (err) fieldErrors.first_name = err;
    } else {
      updates.first_name = raw;
    }
  }
  if (hasLast) {
    const raw = typeof body.last_name === 'string' ? body.last_name.trim() : '';
    if (raw === '') {
      updates.last_name = null;
    } else if (raw.length > AUTH_LIMITS.NAME_MAX) {
      const err = validateName(raw, 'Last name');
      if (err) fieldErrors.last_name = err;
    } else {
      updates.last_name = raw;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json({ fieldErrors }, { status: 400 });
  }
  if (Object.keys(updates).length === 0) {
    // hasFirst/hasLast were both true but neither resolved to a write
    // (would only happen if both bodies were non-string non-undefined).
    return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 });
  }

  try {
    await db.updateTable('profiles')
      .set(updates as never)
      .where('id', '=', userId)
      .execute();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, updated: updates });
}
