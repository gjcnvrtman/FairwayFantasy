import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import { generateInviteCode } from '@/lib/db/queries';
import { validateCreateLeague, LEAGUE_LIMITS } from '@/lib/validation';
import { jsonObjectFrom } from 'kysely/helpers/postgres';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const name       = typeof body.name === 'string' ? body.name.trim() : '';
  const slug       = typeof body.slug === 'string' ? body.slug.trim() : '';
  const maxPlayers = typeof body.maxPlayers === 'number'
    ? body.maxPlayers
    : LEAGUE_LIMITS.MAX_PLAYERS_DEFAULT;
  const startDate  = typeof body.startDate === 'string' ? body.startDate.trim() : '';
  const endDate    = typeof body.endDate   === 'string' ? body.endDate.trim()   : '';
  const weeklyBetAmount = typeof body.weeklyBetAmount === 'number'
    ? body.weeklyBetAmount
    : LEAGUE_LIMITS.BET_DEFAULT;

  // Same validation the form uses client-side — single source of truth.
  // Errors come back as a field-keyed object so the form can highlight
  // the specific input(s) that failed.
  const fieldErrors = validateCreateLeague({
    name, slug, maxPlayers, startDate, endDate, weeklyBetAmount,
  });
  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json({ fieldErrors }, { status: 400 });
  }

  // Uniqueness lives here (not in the validator) because it requires DB.
  const existing = await db.selectFrom('leagues')
    .select('id')
    .where('slug', '=', slug)
    .executeTakeFirst();
  if (existing) {
    return NextResponse.json({
      fieldErrors: { slug: 'That URL is already taken. Please choose another.' },
    }, { status: 409 });
  }

  const inviteCode = generateInviteCode();
  let league;
  try {
    league = await db.insertInto('leagues')
      .values({
        name, slug,
        invite_code:       inviteCode,
        commissioner_id:   user.id,
        max_players:       maxPlayers,
        // Tournament eligibility window. ISO date strings get coerced
        // to TIMESTAMPTZ by pg using the server's TZ — that's fine for
        // a yyyy-mm-dd window comparison.
        start_date:        new Date(startDate + 'T00:00:00Z').toISOString(),
        end_date:          new Date(endDate   + 'T23:59:59Z').toISOString(),
        // NUMERIC(10,2) — pg adapter accepts string or number; format
        // here so the stored value is exactly the validated number.
        weekly_bet_amount: weeklyBetAmount.toFixed(2),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  await db.insertInto('league_members')
    .values({ league_id: league.id, user_id: user.id, role: 'commissioner' })
    .execute();

  return NextResponse.json({ league, inviteUrl: `/join/${slug}/${inviteCode}` });
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  // Old supabase shape was `[{ role, leagues: {...} }]` flattened to
  // `[{...league, role}]`. We do the same thing here via jsonObjectFrom +
  // post-processing to keep the API contract stable for any client.
  const rows = await db.selectFrom('league_members')
    .select(['league_members.role'])
    .select(eb => jsonObjectFrom(
      eb.selectFrom('leagues')
        .selectAll('leagues')
        .whereRef('leagues.id', '=', 'league_members.league_id'),
    ).as('league'))
    .where('user_id', '=', user.id)
    .execute();

  const leagues = rows
    .filter(r => r.league !== null)
    .map(r => ({ ...r.league!, role: r.role }));

  return NextResponse.json({ leagues });
}
