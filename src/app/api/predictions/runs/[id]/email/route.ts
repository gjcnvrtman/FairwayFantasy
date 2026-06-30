// POST /api/predictions/runs/[id]/email — re-send the top-5 email
// for an existing prediction run. Used by the "Email predictions"
// button on /predictions/current. Admin-gated.

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { isPlatformAdmin } from '@/lib/platform-admin';
import { requireSameOrigin } from '@/lib/same-origin';
import { emailPredictionsRun } from '@/lib/predictions-email';

interface Props { params: { id: string } }

export async function POST(req: NextRequest, { params }: Props) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user || !user.email || !isPlatformAdmin(user.email)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const result = await emailPredictionsRun(params.id);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : 'Internal error',
    }, { status: 500 });
  }
}
