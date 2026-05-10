import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { supabaseAdmin } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { slug, inviteCode } = await req.json();

  const { data: league } = await supabaseAdmin
    .from('leagues').select('*').eq('slug', slug).eq('invite_code', inviteCode).single();
  if (!league) return NextResponse.json({ error: 'Invalid invite link.' }, { status: 404 });

  const { data: existing } = await supabaseAdmin
    .from('league_members').select('id').eq('league_id', league.id).eq('user_id', user.id).single();
  if (existing) return NextResponse.json({ league, alreadyMember: true });

  const { count } = await supabaseAdmin
    .from('league_members').select('*', { count: 'exact', head: true }).eq('league_id', league.id);
  if (count && count >= league.max_players)
    return NextResponse.json({ error: 'This league is full.' }, { status: 403 });

  await supabaseAdmin.from('league_members')
    .insert({ league_id: league.id, user_id: user.id, role: 'member' });

  return NextResponse.json({ league, joined: true });
}
