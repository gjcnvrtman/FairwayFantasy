import { createServerSupabaseClient } from '@/lib/supabase-server';
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, generateInviteCode } from '@/lib/supabase';
import { validateCreateLeague, LEAGUE_LIMITS } from '@/lib/validation';

export async function POST(req: NextRequest) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
  const maxPlayers = typeof body.maxPlayers === 'number'
    ? body.maxPlayers
    : LEAGUE_LIMITS.MAX_PLAYERS_DEFAULT;

  // Same validation the form uses client-side — single source of truth.
  // Errors come back as a field-keyed object so the form can highlight
  // the specific input(s) that failed.
  const fieldErrors = validateCreateLeague({ name, slug, maxPlayers });
  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json({ fieldErrors }, { status: 400 });
  }

  // Uniqueness lives here (not in the validator) because it requires DB.
  const { data: existing } = await supabaseAdmin
    .from('leagues').select('id').eq('slug', slug).single();
  if (existing) {
    return NextResponse.json({
      fieldErrors: { slug: 'That URL is already taken. Please choose another.' },
    }, { status: 409 });
  }

  const inviteCode = generateInviteCode();
  const { data: league, error } = await supabaseAdmin
    .from('leagues')
    .insert({
      name, slug,
      invite_code: inviteCode,
      commissioner_id: user.id,
      max_players: maxPlayers,
    })
    .select().single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await supabaseAdmin.from('league_members')
    .insert({ league_id: league.id, user_id: user.id, role: 'commissioner' });

  return NextResponse.json({ league, inviteUrl: `/join/${slug}/${inviteCode}` });
}

export async function GET(req: NextRequest) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: memberships } = await supabaseAdmin
    .from('league_members').select('role, leagues(*)').eq('user_id', user.id);

  return NextResponse.json({ leagues: memberships?.map((m: any) => ({ ...m.leagues, role: m.role })) ?? [] });
}
