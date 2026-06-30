// ============================================================
// /api/predictions/runs/[id] — fetch one run + its per-golfer
// predictions + foursomes. Admin-gated (404 on miss).
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { isPlatformAdmin } from '@/lib/platform-admin';
import { db } from '@/lib/db';

interface Props { params: { id: string } }

export async function GET(_req: NextRequest, { params }: Props) {
  const user = await getCurrentUser();
  if (!user || !isPlatformAdmin(user.email)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const run = await db.selectFrom('tournament_prediction_runs')
    .selectAll()
    .where('id', '=', params.id)
    .executeTakeFirst();
  if (!run) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Per-golfer predictions + foursomes for this run, both keyed on
  // run_id. Returned in display-useful order: composite DESC for
  // golfers, rank ASC for foursomes.
  const [golfers, foursomes] = await Promise.all([
    db.selectFrom('golfer_predictions')
      .innerJoin('golfers', 'golfers.id', 'golfer_predictions.golfer_id')
      .select([
        'golfer_predictions.golfer_id as golferId',
        'golfers.name as name',
        'golfer_predictions.is_top_tier as isTopTier',
        'golfer_predictions.course_fit_score as courseFit',
        'golfer_predictions.recent_form_score as recentForm',
        'golfer_predictions.long_term_score as longTerm',
        'golfer_predictions.course_history_score as courseHistory',
        'golfer_predictions.cut_probability_score as cutProbability',
        'golfer_predictions.upside_score as upside',
        'golfer_predictions.composite_score as composite',
        'golfer_predictions.projected_strokes_to_par as projectedStrokesToPar',
        'golfer_predictions.projected_cut_made_prob as projectedCutMadeProb',
        'golfer_predictions.explanation as explanation',
      ])
      .where('golfer_predictions.run_id', '=', params.id)
      .orderBy('golfer_predictions.composite_score', 'desc')
      .execute(),
    db.selectFrom('foursome_recommendations')
      .selectAll()
      .where('run_id', '=', params.id)
      .orderBy('rank', 'asc')
      .execute(),
  ]);

  return NextResponse.json({ ok: true, run, golfers, foursomes });
}
