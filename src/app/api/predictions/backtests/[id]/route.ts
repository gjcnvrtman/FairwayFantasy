// /api/predictions/backtests/[id] — fetch one backtest run + per-event
// results. Admin-gated.

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { isPlatformAdmin } from '@/lib/platform-admin';
import { db } from '@/lib/db';

interface Props { params: { id: string } }

export async function GET(_req: NextRequest, { params }: Props) {
  const user = await getCurrentUser();
  if (!user || !user.email || !isPlatformAdmin(user.email)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const run = await db.selectFrom('backtest_runs')
    .selectAll()
    .where('id', '=', params.id)
    .executeTakeFirst();
  if (!run) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const results = await db.selectFrom('backtest_results')
    .innerJoin('tournaments', 'tournaments.id', 'backtest_results.tournament_id')
    .select([
      'backtest_results.id as id',
      'backtest_results.tournament_id as tournament_id',
      'tournaments.name as tournament_name',
      'tournaments.start_date as start_date',
      'backtest_results.prediction_run_id as prediction_run_id',
      'backtest_results.projected_score as projected_score',
      'backtest_results.actual_score as actual_score',
      'backtest_results.best_recommended_rank_in_league as best_recommended_rank_in_league',
      'backtest_results.beat_league_average as beat_league_average',
      'backtest_results.beat_league_winner as beat_league_winner',
      'backtest_results.avg_finish_recommended as avg_finish_recommended',
      'backtest_results.made_cut_pct as made_cut_pct',
      'backtest_results.top_10_pct as top_10_pct',
      'backtest_results.top_20_pct as top_20_pct',
      'backtest_results.total_fantasy_points as total_fantasy_points',
      'backtest_results.regret_score as regret_score',
      'backtest_results.sleeper_accuracy as sleeper_accuracy',
      'backtest_results.details as details',
    ])
    .where('backtest_results.backtest_run_id', '=', params.id)
    .orderBy('tournaments.start_date', 'asc')
    .execute();
  return NextResponse.json({ ok: true, run, results });
}
