// /api/predictions/backtests
//
// POST — create + run a backtest across the requested tournaments.
// GET  — list recent backtest runs (aggregate summary only).
// Admin-gated → 404 on miss.

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { isPlatformAdmin } from '@/lib/platform-admin';
import { requireSameOrigin } from '@/lib/same-origin';
import { db } from '@/lib/db';
import { createProductionQueries } from '@/lib/db/predictions-queries';
import { runBacktest } from '@/lib/backtest-orchestrator';

// Backtests across many events can take a while — each event runs the
// full predictor + scoring + insert. Set generously.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user || !user.email || !isPlatformAdmin(user.email)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const tournamentIds: string[] = Array.isArray(body.tournament_ids)
    ? (body.tournament_ids as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  if (tournamentIds.length === 0) {
    return NextResponse.json({
      error: 'tournament_ids must be a non-empty array of UUIDs',
    }, { status: 400 });
  }
  const weightConfigId = typeof body.weight_config_id === 'string' ? body.weight_config_id : undefined;

  const queries = createProductionQueries(db);
  try {
    const result = await runBacktest(
      { tournamentIds, weightConfigId, triggeredBy: user.id },
      queries,
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error('backtests POST failed:', err);
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : 'Internal error',
    }, { status: 500 });
  }
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user || !user.email || !isPlatformAdmin(user.email)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const rows = await db.selectFrom('backtest_runs')
    .selectAll()
    .orderBy('started_at', 'desc')
    .limit(50)
    .execute();
  return NextResponse.json({ ok: true, runs: rows });
}
