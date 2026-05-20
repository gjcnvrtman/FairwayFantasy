import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { checkRateLimit, clientIpFromHeaders } from '@/lib/rate-limit';

// Public endpoint (no auth) — used by the picks page to populate the
// golfer-picker. Rate-limited per IP to prevent scripted scraping of
// the full golfer list + rankings. 60 reqs / 10 min comfortably
// covers a normal session (search-as-you-type plus multiple slot
// edits) while making bulk scraping expensive.
const RL_PLAYERS_LIMIT  = 60;
const RL_PLAYERS_WINDOW = 600;

// GET /api/players?tier=top|dark|all&search=name
export async function GET(req: NextRequest) {
  const ip = clientIpFromHeaders(req.headers);
  const rl = await checkRateLimit({
    key:           `players:${ip}`,
    limit:         RL_PLAYERS_LIMIT,
    windowSeconds: RL_PLAYERS_WINDOW,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${rl.retryAfterSeconds}s.` },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds) } },
    );
  }

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
