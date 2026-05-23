// GET /api/picks/setup?slug=the-boys
// Returns everything the picks page needs in one call

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import { getLeagueBySlug } from '@/lib/db/queries';

// Auth-gated, per-user — opt out of static analysis during build.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const slug = req.nextUrl.searchParams.get('slug');
  if (!slug) return NextResponse.json({ error: 'Missing slug' }, { status: 400 });

  const league = await getLeagueBySlug(slug);
  if (!league) return NextResponse.json({ error: 'League not found' }, { status: 404 });

  // Verify membership
  const membership = await db.selectFrom('league_members')
    .select('id')
    .where('league_id', '=', league.id)
    .where('user_id',   '=', user.id)
    .executeTakeFirst();
  if (!membership) return NextResponse.json({ error: 'Not a member' }, { status: 403 });

  // Get next upcoming or active tournament
  const tournament = await db.selectFrom('tournaments')
    .selectAll()
    .where('status', 'in', ['upcoming', 'active'])
    .orderBy('start_date', 'asc')
    .limit(1)
    .executeTakeFirst();

  if (!tournament) return NextResponse.json({ tournament: null, golfers: [], leagueId: league.id });

  // Field gating (Migration 007 / runFieldSync in src/lib/sync.ts).
  // `field_published_at IS NULL` means ESPN hasn't published the
  // tournament's field yet, so the picks UI can't offer a meaningful
  // dropdown. We return an empty golfer list + the flag; the UI
  // renders a "field not yet available" banner in place of the
  // slot/search panel. POST /api/picks enforces the same gate.
  const fieldPublished = tournament.field_published_at !== null;

  // Once published, restrict the golfer list to the actual field —
  // the join against `scores` is the source of truth for "is this
  // golfer in tournament X?" (runFieldSync seeds zero-score rows at
  // publish time, runScoreSync upserts them later with live data).
  // Without this filter the picks page surfaces every golfer the DB
  // has ever known about (e.g. last week's tournament), which is the
  // bug Greg spotted on the leaderboard for CSC.
  const golfers = fieldPublished
    ? await db.selectFrom('golfers')
        .innerJoin('scores', 'scores.golfer_id', 'golfers.id')
        .select(['golfers.id', 'golfers.espn_id', 'golfers.name',
                 'golfers.owgr_rank', 'golfers.is_dark_horse',
                 'golfers.headshot_url', 'golfers.country'])
        .where('scores.tournament_id', '=', tournament.id)
        .orderBy('golfers.owgr_rank', sb => sb.asc().nullsLast())
        .execute()
    : [];

  // Get current user's existing pick (if any)
  const existingPick = await db.selectFrom('picks')
    .selectAll()
    .where('league_id',     '=', league.id)
    .where('tournament_id', '=', tournament.id)
    .where('user_id',       '=', user.id)
    .executeTakeFirst() ?? null;

  // We only truly block identical foursomes — not individual golfers —
  // so `alreadyPickedIds` is informational only and currently empty.
  const alreadyPickedIds: string[] = [];

  // Post-lock: include per-golfer scores so the picks page can render
  // each picked golfer's current status (active / missed_cut / withdrawn /
  // disqualified) + the user can identify candidates eligible for
  // withdrawal replacement (golfers with no round_1 score yet).
  let scores: Array<{
    golfer_id:     string;
    status:        string;
    round_1:       number | null;
    score_to_par:  number | null;
  }> = [];
  if (tournament.status !== 'upcoming') {
    scores = await db.selectFrom('scores')
      .select(['golfer_id', 'status', 'round_1', 'score_to_par'])
      .where('tournament_id', '=', tournament.id)
      .execute();
  }

  return NextResponse.json({
    leagueId:    league.id,
    tournament,
    fieldPublished,
    golfers,
    existingPick,
    alreadyPickedIds,
    scores,
  });
}
