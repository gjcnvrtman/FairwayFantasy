// /api/me/profile — authenticated in-session profile edits.
//
// Currently only display_name is editable here. Email is the auth key
// + verification anchor, so changing it requires the verify-email flow
// (out of scope for this endpoint).
//
// display_name is what every league surface renders — leaderboard,
// history, stats, schedule, nav. Writing here propagates automatically;
// no caller-side cache to bust.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/current-user';
import { validateDisplayName } from '@/lib/auth-validation';
import { requireSameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const raw = typeof body.display_name === 'string' ? body.display_name : '';
  const display_name = raw.trim();

  const nameError = validateDisplayName(display_name);
  if (nameError) {
    return NextResponse.json(
      { fieldErrors: { display_name: nameError } },
      { status: 400 },
    );
  }

  try {
    await db.updateTable('profiles')
      .set({ display_name })
      .where('id', '=', user.id)
      .execute();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, display_name });
}
