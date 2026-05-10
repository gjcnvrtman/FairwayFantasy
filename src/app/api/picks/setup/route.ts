// GET /api/picks/setup?slug=the-boys
// Returns everything the picks page needs in one call

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { supabaseAdmin, getLeagueBySlug } from '@/lib/supabase';

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
  const { data: membership } = await supabaseAdmin
    .from('league_members').select('id').eq('league_id', league.id).eq('user_id', user.id).single();
  if (!membership) return NextResponse.json({ error: 'Not a member' }, { status: 403 });

  // Get next upcoming or active tournament
  const { data: tournament } = await supabaseAdmin
    .from('tournaments')
    .select('*')
    .in('status', ['upcoming', 'active'])
    .order('start_date', { ascending: true })
    .limit(1)
    .single();

  if (!tournament) return NextResponse.json({ tournament: null, golfers: [], leagueId: league.id });

  // Get all golfers sorted by OWGR rank
  const { data: golfers } = await supabaseAdmin
    .from('golfers')
    .select('id, espn_id, name, owgr_rank, is_dark_horse, headshot_url, country')
    .order('owgr_rank', { ascending: true, nullsFirst: false });

  // Get current user's existing pick
  const { data: existingPick } = await supabaseAdmin
    .from('picks')
    .select('*')
    .eq('league_id', league.id)
    .eq('tournament_id', tournament.id)
    .eq('user_id', user.id)
    .single();

  // Get all golfer IDs already picked by OTHER players in this league
  // (used to show "Taken" — but we don't block since uniqueness is about full 4-set)
  const { data: otherPicks } = await supabaseAdmin
    .from('picks')
    .select('golfer_1_id, golfer_2_id, golfer_3_id, golfer_4_id')
    .eq('league_id', league.id)
    .eq('tournament_id', tournament.id)
    .neq('user_id', user.id);

  // We only truly block identical foursomes — not individual golfers
  // So alreadyPickedIds is informational only
  const alreadyPickedIds: string[] = [];

  return NextResponse.json({
    leagueId:    league.id,
    tournament,
    golfers:     golfers ?? [],
    existingPick,
    alreadyPickedIds,
  });
}
