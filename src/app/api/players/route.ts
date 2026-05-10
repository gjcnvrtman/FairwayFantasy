import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET /api/players?tier=top|dark|all&search=name
export async function GET(req: NextRequest) {
  const tier   = req.nextUrl.searchParams.get('tier') ?? 'all';
  const search = req.nextUrl.searchParams.get('search') ?? '';

  let q = db.selectFrom('golfers')
    .select(['id', 'espn_id', 'name', 'owgr_rank', 'is_dark_horse', 'headshot_url', 'country'])
    // nulls last on `owgr_rank` so unranked golfers don't crowd the top.
    .orderBy('owgr_rank', sb => sb.asc().nullsLast())
    .limit(100);

  if (tier === 'top')  q = q.where('is_dark_horse', '=', false);
  if (tier === 'dark') q = q.where('is_dark_horse', '=', true);
  if (search)          q = q.where('name', 'ilike', `%${search}%`);

  try {
    const golfers = await q.execute();
    return NextResponse.json({ golfers });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
