// ============================================================
// /api/predictions/runs
//
// POST — trigger a new prediction run for a tournament. Gated to
//        platform admins only (Greg + MJ). Non-admin → 404 to hide
//        the feature's existence.
//
// GET  — list recent runs for a tournament (?tournament_id=UUID).
//        Same admin gate. Used by the /predictions UI.
//
// Phase 3 admin surface — all writes go through the orchestrator at
// src/lib/predictions-orchestrator.ts. This file is thin glue: auth +
// param parsing + JSON response shape.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { isPlatformAdmin } from '@/lib/platform-admin';
import { requireSameOrigin } from '@/lib/same-origin';
import { db } from '@/lib/db';
import { createProductionQueries } from '@/lib/db/predictions-queries';
import { runPredictions, OrchestratorError } from '@/lib/predictions-orchestrator';

// The orchestrator can take 30-60s on a 144-golfer field while loading
// per-golfer inputs in parallel. Next.js dev/prod defaults are usually
// long enough but the explicit max avoids surprise edge timeouts.
export const maxDuration = 120;

// ── Helper: enforce the admin gate (404 not 403 on miss) ────

async function requireAdmin(): Promise<{
  ok: true; userId: string; email: string;
} | { ok: false; response: NextResponse }> {
  const user = await getCurrentUser();
  // user.email is `string | null`; isPlatformAdmin's NULL guard means
  // we still 404 cleanly if email is missing, but TS needs the explicit
  // check to narrow the type for the success branch below.
  if (!user || !user.email || !isPlatformAdmin(user.email)) {
    return { ok: false, response: NextResponse.json(
      { error: 'Not found' }, { status: 404 }) };
  }
  return { ok: true, userId: user.id, email: user.email };
}

// ── POST: trigger a new run ────────────────────────────────

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const tournamentId = typeof body.tournament_id === 'string' ? body.tournament_id : null;
  const weightConfigId = typeof body.weight_config_id === 'string' ? body.weight_config_id : undefined;
  const statAsOfDate = typeof body.stat_as_of_date === 'string' ? body.stat_as_of_date : undefined;

  if (!tournamentId) {
    return NextResponse.json(
      { error: 'tournament_id is required' }, { status: 400 });
  }
  if (statAsOfDate && !/^\d{4}-\d{2}-\d{2}$/.test(statAsOfDate)) {
    return NextResponse.json(
      { error: 'stat_as_of_date must be YYYY-MM-DD' }, { status: 400 });
  }

  const queries = createProductionQueries(db);
  try {
    const result = await runPredictions(
      { tournamentId, weightConfigId, statAsOfDate, triggeredBy: auth.userId },
      queries,
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof OrchestratorError) {
      // Caller-actionable errors (missing course profile, etc.) get
      // 400 + a clear code so the UI can surface a useful message.
      return NextResponse.json(
        { ok: false, error: err.message, code: err.code }, { status: 400 });
    }
    // Internal — log full stack server-side, surface a short message.
    console.error('predictions/runs POST failed:', err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}

// ── GET: list recent runs (optionally filtered by tournament) ──

export async function GET(req: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const tournamentId = req.nextUrl.searchParams.get('tournament_id');
  const limit = Math.min(50, Math.max(1, Number(req.nextUrl.searchParams.get('limit') ?? 20)));

  let q = db.selectFrom('tournament_prediction_runs')
    .selectAll()
    .orderBy('started_at', 'desc')
    .limit(limit);
  if (tournamentId) q = q.where('tournament_id', '=', tournamentId);
  const rows = await q.execute();

  return NextResponse.json({ ok: true, runs: rows });
}
