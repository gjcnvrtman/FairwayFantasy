import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { computeTopTierIds } from '@/lib/field-tiers';
import { checkRateLimit, clientIpFromHeaders } from '@/lib/rate-limit';

// Public endpoint (no auth) — used by the picks page to populate the
// golfer-picker. Rate-limited per IP to prevent scripted scraping of
// the full golfer list + rankings. 60 reqs / 10 min comfortably
// covers a normal session (search-as-you-type plus multiple slot
// edits) while making bulk scraping expensive.
const RL_PLAYERS_LIMIT  = 60;
const RL_PLAYERS_WINDOW = 600;

// GET /api/players?tier=top|dark|all&search=name&tournament_id=<uuid>
//
// `tier=top|dark` requires `tournament_id` — tier is per-tournament-
// field as of 2026-06-13, computed via computeTopTierIds against the
// field (golfers joined through `scores` for that tournament).
// `tier=all` (or omitted) returns the global golfer list — no
// tournament context needed.
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

  const tier         = req.nextUrl.searchParams.get('tier') ?? 'all';
  const search       = req.nextUrl.searchParams.get('search') ?? '';
  const tournamentId = req.nextUrl.searchParams.get('tournament_id');

  if ((tier === 'top' || tier === 'dark') && !tournamentId) {
    return NextResponse.json(
      { error: `tier=${tier} requires tournament_id (tier is per-tournament-field).` },
      { status: 400 },
    );
  }

  try {
    // tier=top|dark → restrict to the tournament field + classify.
    if (tier === 'top' || tier === 'dark') {
      const field = await db.selectFrom('golfers')
        .innerJoin('scores', 'scores.golfer_id', 'golfers.id')
        .select(['golfers.id', 'golfers.espn_id', 'golfers.name',
                 'golfers.owgr_rank', 'golfers.is_dark_horse',
                 'golfers.headshot_url', 'golfers.country'])
        .where('scores.tournament_id', '=', tournamentId as string)
        .$if(!!search, qb => qb.where('golfers.name', 'ilike', `%${search}%`))
        .orderBy('golfers.owgr_rank', sb => sb.asc().nullsLast())
        .limit(200)
        .execute();
      const topTierIds = computeTopTierIds(field);
      const filtered = tier === 'top'
        ? field.filter(g => topTierIds.has(g.id))
        : field.filter(g => !topTierIds.has(g.id));
      return NextResponse.json({ golfers: filtered });
    }

    // tier=all → global golfer list.
    let q = db.selectFrom('golfers')
      .select(['id', 'espn_id', 'name', 'owgr_rank', 'is_dark_horse', 'headshot_url', 'country'])
      .orderBy('owgr_rank', sb => sb.asc().nullsLast())
      .limit(100);
    if (search) q = q.where('name', 'ilike', `%${search}%`);
    const golfers = await q.execute();
    return NextResponse.json({ golfers });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
