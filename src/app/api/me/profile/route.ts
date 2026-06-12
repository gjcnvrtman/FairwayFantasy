// /api/me/profile — authenticated in-session profile edits.
//
// Editable: display_name (always), first_name + last_name (optional,
// added 2026-06-12). Email is the auth key + verification anchor, so
// changing it would require a separate verify-email flow (out of scope).
//
// All three fields propagate to every league surface via the profile
// join — leaderboard, history, stats, nav. No caller-side cache to bust.
//
// Partial updates: only fields present in the request body are written.
// Sending `{ display_name: 'foo' }` won't touch first_name/last_name,
// and vice-versa, so the per-card forms on /account can submit
// independently without clobbering each other.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/current-user';
import {
  validateDisplayName,
  validateName,
  AUTH_LIMITS,
} from '@/lib/auth-validation';
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

  const fieldErrors: Record<string, string> = {};
  const updates: Record<string, string | null> = {};

  // display_name — full validation when provided.
  if (body.display_name !== undefined) {
    const raw = typeof body.display_name === 'string' ? body.display_name.trim() : '';
    const err = validateDisplayName(raw);
    if (err) fieldErrors.display_name = err;
    else     updates.display_name = raw;
  }

  // first_name / last_name — optional, length-bounded. Empty string
  // means "clear it" (NULL in the DB) rather than "missing". Treating
  // empty as omit would silently turn a "clear my name" save into a
  // no-op, which is worse than the friction of typing one letter.
  for (const f of ['first_name', 'last_name'] as const) {
    if (body[f] !== undefined) {
      const raw = typeof body[f] === 'string' ? (body[f] as string).trim() : '';
      if (raw === '') {
        updates[f] = null;
      } else if (raw.length > AUTH_LIMITS.NAME_MAX) {
        const label = f === 'first_name' ? 'First name' : 'Last name';
        const err = validateName(raw, label);
        if (err) fieldErrors[f] = err;
      } else {
        updates[f] = raw;
      }
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json({ fieldErrors }, { status: 400 });
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No editable fields supplied.' }, { status: 400 });
  }

  try {
    await db.updateTable('profiles')
      .set(updates as never)
      .where('id', '=', user.id)
      .execute();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, updated: updates });
}
