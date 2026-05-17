import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import { validatePick, isReplacementEligible } from '@/lib/scoring';
import { checkRateLimit, clientIpFromHeaders } from '@/lib/rate-limit';
import { isPickDeadlinePassed } from '@/lib/pick-deadline';

// Per-IP rate limit on pick submission: 30 attempts per 10 min.
// Legit users can iterate freely (edit picks multiple times before
// lock); scripted abuse gets shut down. Keyed by IP rather than
// user_id so a single attacker can't burn through 30 different
// invite-acquired accounts.
const RL_PICKS_LIMIT  = 30;
const RL_PICKS_WINDOW = 600;

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const ip = clientIpFromHeaders(req.headers);
  const rl = await checkRateLimit({
    key:           `picks:${ip}`,
    limit:         RL_PICKS_LIMIT,
    windowSeconds: RL_PICKS_WINDOW,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Too many pick changes. Slow down and try again in ${rl.retryAfterSeconds}s.` },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds) } },
    );
  }

  const { leagueId, tournamentId, golferIds } = await req.json();

  // Verify membership
  const membership = await db.selectFrom('league_members')
    .select('id')
    .where('league_id', '=', leagueId)
    .where('user_id', '=', user.id)
    .executeTakeFirst();
  if (!membership) return NextResponse.json({ error: 'Not a member of this league.' }, { status: 403 });

  // Check tournament is still open
  const tournament = await db.selectFrom('tournaments')
    .select(['pick_deadline', 'pick_deadline_override', 'status', 'name'])
    .where('id', '=', tournamentId)
    .executeTakeFirst();
  if (!tournament) return NextResponse.json({ error: 'Tournament not found.' }, { status: 404 });
  if (tournament.status !== 'upcoming')
    return NextResponse.json({ error: 'Picks are locked — this tournament has started.' }, { status: 403 });
  // Honor commissioner override (P1 — pick_deadline often wrong vs real tee time).
  if (isPickDeadlinePassed(tournament))
    return NextResponse.json({ error: 'The pick deadline has passed.' }, { status: 403 });

  // Validate golfer tiers
  const nonNull = (golferIds as Array<string | null>).filter(Boolean) as string[];
  const golfers = nonNull.length > 0
    ? await db.selectFrom('golfers')
        .select(['id', 'name', 'owgr_rank', 'is_dark_horse'])
        .where('id', 'in', nonNull)
        .execute()
    : [];

  // Get other picks for duplicate check
  const existingPicks = await db.selectFrom('picks')
    .select(['golfer_1_id', 'golfer_2_id', 'golfer_3_id', 'golfer_4_id'])
    .where('league_id',     '=',  leagueId)
    .where('tournament_id', '=',  tournamentId)
    .where('user_id',       '!=', user.id)
    .execute();

  // validatePick wants string FKs (not nullable) so filter only fully-formed rows.
  const eligible = existingPicks.filter(p =>
    p.golfer_1_id && p.golfer_2_id && p.golfer_3_id && p.golfer_4_id,
  ) as Array<{ golfer_1_id: string; golfer_2_id: string; golfer_3_id: string; golfer_4_id: string }>;

  const errors = validatePick({ golferIds, golfers, existingPicks: eligible });
  if (errors.length > 0) return NextResponse.json({ errors }, { status: 400 });

  try {
    const pick = await db.insertInto('picks')
      .values({
        league_id:     leagueId,
        tournament_id: tournamentId,
        user_id:       user.id,
        golfer_1_id:   golferIds[0],
        golfer_2_id:   golferIds[1],
        golfer_3_id:   golferIds[2],
        golfer_4_id:   golferIds[3],
        is_locked:     false,
        submitted_at:  new Date().toISOString(),
      })
      .onConflict(oc => oc
        .columns(['league_id', 'tournament_id', 'user_id'])
        .doUpdateSet(eb => ({
          golfer_1_id:  eb.ref('excluded.golfer_1_id'),
          golfer_2_id:  eb.ref('excluded.golfer_2_id'),
          golfer_3_id:  eb.ref('excluded.golfer_3_id'),
          golfer_4_id:  eb.ref('excluded.golfer_4_id'),
          is_locked:    eb.ref('excluded.is_locked'),
          submitted_at: eb.ref('excluded.submitted_at'),
        })),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return NextResponse.json({ pick, success: true });
  } catch (err) {
    // The partial unique index `picks_unique_complete_foursome`
    // closes the race window where two users in the same league
    // submit identical foursomes concurrently. App-level
    // `validatePick` catches the common case; this 409 handles the
    // narrow race where both POSTs slip past validation.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('picks_unique_complete_foursome')) {
      return NextResponse.json(
        { error: 'Another player in your league already submitted that exact foursome. Pick a different combination.' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// Withdrawal replacement
export async function PUT(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { pickId, withdrawnGolferId, replacementGolferId } = await req.json();

  const pick = await db.selectFrom('picks')
    .selectAll()
    .where('id', '=', pickId)
    .where('user_id', '=', user.id)
    .executeTakeFirst();
  if (!pick) return NextResponse.json({ error: 'Pick not found.' }, { status: 404 });

  const pickGolferIds = [pick.golfer_1_id, pick.golfer_2_id, pick.golfer_3_id, pick.golfer_4_id];
  if (!pickGolferIds.includes(withdrawnGolferId))
    return NextResponse.json({ error: 'That golfer is not in your pick.' }, { status: 400 });

  // Replacement must not have teed off AND must still be active.
  // isReplacementEligible (src/lib/scoring.ts) is the single source of
  // truth — checks both round_1 IS NULL and status='active' so a
  // pre-tournament WD/DQ can't slip through.
  const repScore = await db.selectFrom('scores')
    .select(['round_1', 'status'])
    .where('golfer_id',     '=', replacementGolferId)
    .where('tournament_id', '=', pick.tournament_id)
    .executeTakeFirst();
  if (!repScore || !isReplacementEligible(repScore))
    return NextResponse.json(
      { error: 'That golfer is not eligible — either already teed off or no longer active in the field.' },
      { status: 400 },
    );

  await db.updateTable('scores')
    .set({ was_replaced: true, replaced_by_golfer_id: replacementGolferId })
    .where('golfer_id',     '=', withdrawnGolferId)
    .where('tournament_id', '=', pick.tournament_id)
    .execute();

  return NextResponse.json({ success: true });
}
