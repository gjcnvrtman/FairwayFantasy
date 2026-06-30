// /api/predictions/weights/[id] — PUT updates a config. DELETE removes
// it (refuses if it's currently active). POST to ./activate flips
// active to this config and deactivates the previous active.

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { isPlatformAdmin } from '@/lib/platform-admin';
import { requireSameOrigin } from '@/lib/same-origin';
import { db } from '@/lib/db';

interface Props { params: { id: string } }

interface UpdatePayload {
  description?: unknown;
  course_fit_weight?: unknown;
  recent_form_weight?: unknown;
  long_term_weight?: unknown;
  course_history_weight?: unknown;
  cut_probability_weight?: unknown;
  upside_weight?: unknown;
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user || !user.email || !isPlatformAdmin(user.email)) {
    return { ok: false as const,
      response: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
  }
  return { ok: true as const };
}

export async function PUT(req: NextRequest, { params }: Props) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as UpdatePayload;
  const weights = {
    course_fit:      num(body.course_fit_weight),
    recent_form:     num(body.recent_form_weight),
    long_term:       num(body.long_term_weight),
    course_history:  num(body.course_history_weight),
    cut_probability: num(body.cut_probability_weight),
    upside:          num(body.upside_weight),
  };
  for (const [k, v] of Object.entries(weights)) {
    if (v == null) {
      return NextResponse.json({
        error: `${k}_weight is required and must be a number`,
      }, { status: 400 });
    }
    if (v < 0 || v > 1) {
      return NextResponse.json({
        error: `${k}_weight ${v} out of [0, 1]`,
      }, { status: 400 });
    }
  }
  const sum = Object.values(weights).reduce((a, b) => (a ?? 0) + (b ?? 0), 0) ?? 0;
  if (Math.abs(sum - 1) > 0.005) {
    return NextResponse.json({
      error: `weights must sum to 1.0 (got ${sum.toFixed(4)})`,
    }, { status: 400 });
  }

  try {
    await db.updateTable('model_weight_configs')
      .set({
        description:            typeof body.description === 'string' ? body.description : null,
        course_fit_weight:      weights.course_fit!.toString(),
        recent_form_weight:     weights.recent_form!.toString(),
        long_term_weight:       weights.long_term!.toString(),
        course_history_weight:  weights.course_history!.toString(),
        cut_probability_weight: weights.cut_probability!.toString(),
        upside_weight:          weights.upside!.toString(),
      })
      .where('id', '=', params.id)
      .execute();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : 'Internal error',
    }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: Props) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  // Refuse to delete the active config — the predictor needs one.
  const target = await db.selectFrom('model_weight_configs')
    .select(['is_active'])
    .where('id', '=', params.id)
    .executeTakeFirst();
  if (!target) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (target.is_active) {
    return NextResponse.json({
      error: 'Cannot delete the active config — activate another one first',
    }, { status: 400 });
  }
  await db.deleteFrom('model_weight_configs')
    .where('id', '=', params.id)
    .execute();
  return NextResponse.json({ ok: true });
}
