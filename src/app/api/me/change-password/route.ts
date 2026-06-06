// /api/me/change-password — authenticated in-session password change.
//
// Distinct from /api/auth/reset-password (token-authed, for forgot-
// password flow) — this path is for users who are already signed in
// and want to rotate their password from the Account page. They MUST
// supply the current password; we don't trust the session alone to
// permit a credential change (defense against session-cookie theft
// turning into permanent account takeover).
//
// Failure modes surfaced to the client:
//   401 — not authenticated (no session)
//   400 — missing/invalid body fields, new password fails complexity
//   401 — current password does not match the stored hash
//   500 — DB write failure

import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/current-user';
import { validatePassword } from '@/lib/auth-validation';
import { requireSameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const BCRYPT_COST = 10;

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const current = typeof body.current_password === 'string' ? body.current_password : '';
  const next    = typeof body.new_password     === 'string' ? body.new_password     : '';

  if (!current) {
    return NextResponse.json(
      { fieldErrors: { current_password: 'Current password is required.' } },
      { status: 400 },
    );
  }
  const pwError = validatePassword(next);
  if (pwError) {
    return NextResponse.json(
      { fieldErrors: { new_password: pwError } },
      { status: 400 },
    );
  }
  if (current === next) {
    return NextResponse.json(
      { fieldErrors: { new_password: 'New password must be different from the current one.' } },
      { status: 400 },
    );
  }

  const row = await db.selectFrom('auth_credentials')
    .select(['password_hash'])
    .where('user_id', '=', user.id)
    .executeTakeFirst();

  // No credential row means the account isn't password-authed — which
  // shouldn't be possible for a session that survived signin, but
  // guard anyway. Same 401 message as a bad password so we don't
  // leak account state to a stolen cookie.
  if (!row?.password_hash) {
    return NextResponse.json(
      { fieldErrors: { current_password: 'Current password is incorrect.' } },
      { status: 401 },
    );
  }

  const ok = await bcrypt.compare(current, row.password_hash);
  if (!ok) {
    return NextResponse.json(
      { fieldErrors: { current_password: 'Current password is incorrect.' } },
      { status: 401 },
    );
  }

  const password_hash = await bcrypt.hash(next, BCRYPT_COST);

  try {
    await db.updateTable('auth_credentials')
      .set({
        password_hash,
        // Defense in depth: if a forgotten-password token was outstanding
        // when the user changed their password in-session, invalidate it
        // so the emailed link can't be used to reset back.
        reset_token:         null,
        reset_token_expires: null,
        updated_at:          new Date().toISOString(),
      })
      .where('user_id', '=', user.id)
      .execute();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
