// GET /api/leagues/verify?slug=xxx&code=yyy
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get('slug');
  const code = req.nextUrl.searchParams.get('code');

  if (!slug || !code) return NextResponse.json({ error: 'Missing params' }, { status: 400 });

  const league = await db.selectFrom('leagues')
    .select(['id', 'name'])
    .where('slug', '=', slug)
    .where('invite_code', '=', code)
    .executeTakeFirst();

  if (!league) return NextResponse.json({ error: 'Invalid invite' }, { status: 404 });

  return NextResponse.json({ leagueName: league.name });
}
