import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { slug, inviteCode } = await req.json();

  const league = await db.selectFrom('leagues')
    .selectAll()
    .where('slug', '=', slug)
    .where('invite_code', '=', inviteCode)
    .executeTakeFirst();
  if (!league) return NextResponse.json({ error: 'Invalid invite link.' }, { status: 404 });

  const existing = await db.selectFrom('league_members')
    .select('id')
    .where('league_id', '=', league.id)
    .where('user_id', '=', user.id)
    .executeTakeFirst();
  if (existing) return NextResponse.json({ league, alreadyMember: true });

  // Capacity check — count rows directly. (Supabase's `head: true`
  // count was a roundtrip-saver; kysely's a single SELECT count(*).)
  const { count } = await db.selectFrom('league_members')
    .select(eb => eb.fn.countAll<string>().as('count'))
    .where('league_id', '=', league.id)
    .executeTakeFirstOrThrow();
  const memberCount = Number(count);
  if (memberCount >= league.max_players) {
    return NextResponse.json({ error: 'This league is full.' }, { status: 403 });
  }

  await db.insertInto('league_members')
    .values({ league_id: league.id, user_id: user.id, role: 'member' })
    .execute();

  return NextResponse.json({ league, joined: true });
}
