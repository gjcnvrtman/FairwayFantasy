// /api/auth/register — public POST. Creates a profile + auth_credentials
// row, hashes the password with bcrypt cost 10. Does NOT auto-login;
// the signup form calls signIn() right after.

import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { validateRegistration } from '@/lib/auth-validation';

// Auth flow — never prerender.
export const dynamic = 'force-dynamic';

const BCRYPT_COST = 10;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as Record<string, unknown>));

  const email        = typeof body.email        === 'string' ? body.email.trim().toLowerCase() : '';
  const display_name = typeof body.display_name === 'string' ? body.display_name.trim()         : '';
  const password     = typeof body.password     === 'string' ? body.password                    : '';

  // Single source of truth for validation — same fn the form uses.
  const fieldErrors = validateRegistration({ email, display_name, password });
  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json({ fieldErrors }, { status: 400 });
  }

  // Email uniqueness — schema enforces but we surface a friendly
  // error instead of a 500 from the constraint violation.
  const existing = await db.selectFrom('profiles')
    .select('id')
    .where('email', '=', email)
    .executeTakeFirst();
  if (existing) {
    return NextResponse.json({
      fieldErrors: { email: 'An account with that email already exists. Sign in instead?' },
    }, { status: 409 });
  }

  const password_hash = await bcrypt.hash(password, BCRYPT_COST);

  // Insert profile + auth_credentials atomically. If either fails,
  // we don't want to leave a half-created user. kysely transactions:
  try {
    await db.transaction().execute(async tx => {
      const profile = await tx.insertInto('profiles')
        .values({ email, display_name })
        .returning('id')
        .executeTakeFirstOrThrow();

      await tx.insertInto('auth_credentials')
        .values({
          user_id:        profile.id,
          password_hash,
          // email_verified false by default — banner UX, not a login gate.
        })
        .execute();
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
