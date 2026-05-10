import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { supabaseAdmin } from '@/lib/supabase';
import { validatePick } from '@/lib/scoring';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { leagueId, tournamentId, golferIds } = await req.json();

  // Verify membership
  const { data: membership } = await supabaseAdmin
    .from('league_members').select('id').eq('league_id', leagueId).eq('user_id', user.id).single();
  if (!membership) return NextResponse.json({ error: 'Not a member of this league.' }, { status: 403 });

  // Check tournament is still open
  const { data: tournament } = await supabaseAdmin
    .from('tournaments').select('pick_deadline, status, name').eq('id', tournamentId).single();
  if (!tournament) return NextResponse.json({ error: 'Tournament not found.' }, { status: 404 });
  if (tournament.status !== 'upcoming')
    return NextResponse.json({ error: 'Picks are locked — this tournament has started.' }, { status: 403 });
  if (tournament.pick_deadline && new Date() > new Date(tournament.pick_deadline))
    return NextResponse.json({ error: 'The pick deadline has passed.' }, { status: 403 });

  // Validate golfer tiers
  const nonNull = golferIds.filter(Boolean);
  const { data: golfers } = await supabaseAdmin
    .from('golfers').select('id, name, owgr_rank, is_dark_horse').in('id', nonNull);
  if (!golfers) return NextResponse.json({ error: 'Could not load golfer data.' }, { status: 500 });

  // Get other picks for duplicate check
  const { data: existingPicks } = await supabaseAdmin
    .from('picks')
    .select('golfer_1_id, golfer_2_id, golfer_3_id, golfer_4_id')
    .eq('league_id', leagueId).eq('tournament_id', tournamentId).neq('user_id', user.id);

  const errors = validatePick({ golferIds, golfers, existingPicks: existingPicks ?? [] });
  if (errors.length > 0) return NextResponse.json({ errors }, { status: 400 });

  const { data: pick, error } = await supabaseAdmin
    .from('picks')
    .upsert({
      league_id: leagueId, tournament_id: tournamentId, user_id: user.id,
      golfer_1_id: golferIds[0], golfer_2_id: golferIds[1],
      golfer_3_id: golferIds[2], golfer_4_id: golferIds[3],
      is_locked: false, submitted_at: new Date().toISOString(),
    }, { onConflict: 'league_id,tournament_id,user_id' })
    .select().single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ pick, success: true });
}

// Withdrawal replacement
export async function PUT(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { pickId, withdrawnGolferId, replacementGolferId } = await req.json();

  const { data: pick } = await supabaseAdmin
    .from('picks').select('*').eq('id', pickId).eq('user_id', user.id).single();
  if (!pick) return NextResponse.json({ error: 'Pick not found.' }, { status: 404 });

  const pickGolferIds = [pick.golfer_1_id, pick.golfer_2_id, pick.golfer_3_id, pick.golfer_4_id];
  if (!pickGolferIds.includes(withdrawnGolferId))
    return NextResponse.json({ error: 'That golfer is not in your pick.' }, { status: 400 });

  // Ensure replacement hasn't teed off (round_1 still null)
  const { data: repScore } = await supabaseAdmin
    .from('scores').select('round_1').eq('golfer_id', replacementGolferId)
    .eq('tournament_id', pick.tournament_id).single();
  if (repScore?.round_1 !== null)
    return NextResponse.json({ error: 'That golfer has already teed off.' }, { status: 400 });

  await supabaseAdmin.from('scores')
    .update({ was_replaced: true, replaced_by_golfer_id: replacementGolferId })
    .eq('golfer_id', withdrawnGolferId).eq('tournament_id', pick.tournament_id);

  return NextResponse.json({ success: true });
}
