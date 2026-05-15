// /api/auth/verify — consume a verification token issued at signup.
//
// GET ?token=<hex>:
//   - look up auth_credentials by verify_token
//   - check expiry
//   - flip email_verified=true, clear verify_token + verify_token_expires
//   - return JSON { ok: true } on success, { error, expired? } on failure
//
// The /auth/verify page calls this from its client component.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// Auth flow — never prerender.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = new URL(req.url).searchParams.get('token') ?? '';
  if (!token) {
    return NextResponse.json({ error: 'Missing token.' }, { status: 400 });
  }

  const row = await db.selectFrom('auth_credentials')
    .select(['user_id', 'email_verified', 'verify_token_expires'])
    .where('verify_token', '=', token)
    .executeTakeFirst();

  if (!row) {
    return NextResponse.json(
      { error: 'Verification link is invalid or has already been used.' },
      { status: 404 },
    );
  }

  if (row.email_verified) {
    // Idempotent re-click — treat as success.
    return NextResponse.json({ ok: true, alreadyVerified: true });
  }

  if (row.verify_token_expires && new Date(row.verify_token_expires) < new Date()) {
    return NextResponse.json(
      { error: 'Verification link has expired. Request a new one.', expired: true },
      { status: 410 },
    );
  }

  await db.updateTable('auth_credentials')
    .set({
      email_verified:       true,
      verify_token:         null,
      verify_token_expires: null,
      updated_at:           new Date().toISOString(),
    })
    .where('user_id', '=', row.user_id)
    .execute();

  return NextResponse.json({ ok: true });
}
