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

  // Get all golfers sorted by OWGR rank, unranked at the bottom
  const golfers = await db.selectFrom('golfers')
    .select(['id', 'espn_id', 'name', 'owgr_rank', 'is_dark_horse', 'headshot_url', 'country'])
    .orderBy('owgr_rank', sb => sb.asc().nullsLast())
    .execute();

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

  return NextResponse.json({
    leagueId:    league.id,
    tournament,
    golfers,
    existingPick,
    alreadyPickedIds,
  });
}
