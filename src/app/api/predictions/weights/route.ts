// /api/predictions/weights — list + create model weight configs.
// Admin-gated.

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { isPlatformAdmin } from '@/lib/platform-admin';
import { requireSameOrigin } from '@/lib/same-origin';
import { db } from '@/lib/db';

interface CreatePayload {
  name?: unknown;
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
  return { ok: true as const, userId: user.id };
}

export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  const rows = await db.selectFrom('model_weight_configs')
    .selectAll()
    .orderBy('created_at', 'desc')
    .execute();
  return NextResponse.json({ ok: true, configs: rows });
}

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as CreatePayload;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

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
    const row = await db.insertInto('model_weight_configs')
      .values({
        name,
        course_fit_weight:      weights.course_fit!.toString(),
        recent_form_weight:     weights.recent_form!.toString(),
        long_term_weight:       weights.long_term!.toString(),
        course_history_weight:  weights.course_history!.toString(),
        cut_probability_weight: weights.cut_probability!.toString(),
        upside_weight:          weights.upside!.toString(),
        is_active:              false,
        description:            typeof body.description === 'string' ? body.description : null,
        created_by:             auth.userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return NextResponse.json({ ok: true, id: row.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    const status = /unique/i.test(message) ? 409 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
