// POST /api/predictions/weights/[id]/activate — make this config
// active and deactivate the previously-active one in a transaction.
// The partial unique index `uq_model_weight_one_active` enforces the
// "at most one active" invariant; the two updates have to land inside
// a transaction so the index never sees zero-or-two active rows.

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { isPlatformAdmin } from '@/lib/platform-admin';
import { requireSameOrigin } from '@/lib/same-origin';
import { db } from '@/lib/db';

interface Props { params: { id: string } }

export async function POST(req: NextRequest, { params }: Props) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user || !user.email || !isPlatformAdmin(user.email)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const target = await db.selectFrom('model_weight_configs')
    .select(['id', 'is_active'])
    .where('id', '=', params.id)
    .executeTakeFirst();
  if (!target) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (target.is_active) {
    return NextResponse.json({ ok: true, alreadyActive: true });
  }

  try {
    await db.transaction().execute(async trx => {
      // Deactivate any current active first to satisfy the unique
      // index on is_active=TRUE.
      await trx.updateTable('model_weight_configs')
        .set({ is_active: false })
        .where('is_active', '=', true)
        .execute();
      await trx.updateTable('model_weight_configs')
        .set({ is_active: true })
        .where('id', '=', params.id)
        .execute();
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : 'Internal error',
    }, { status: 500 });
  }
}
