import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import { generateInviteCode } from '@/lib/db/queries';
import { validateCreateLeague, LEAGUE_LIMITS } from '@/lib/validation';
import { requireSameOrigin } from '@/lib/same-origin';
import { importPGAScheduleFromESPN } from '@/lib/schedule-import';
import { jsonObjectFrom } from 'kysely/helpers/postgres';

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

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
  // Setup-time rules (migration 025). Absent → defaults that match the
  // pre-025 behavior. Majors bet: null means "same as weekly".
  const majorBetAmount: number | null =
    typeof body.majorBetAmount === 'number' ? body.majorBetAmount : null;
  const payoutPct1 = typeof body.payoutPct1 === 'number' ? body.payoutPct1 : 100;
  const payoutPct2 = typeof body.payoutPct2 === 'number' ? body.payoutPct2 : 0;
  const payoutPct3 = typeof body.payoutPct3 === 'number' ? body.payoutPct3 : 0;
  const missedCutPenalty = typeof body.missedCutPenalty === 'number'
    ? body.missedCutPenalty
    : LEAGUE_LIMITS.MISSED_CUT_PENALTY_DEFAULT;
  const missedDeadlinePenalty = typeof body.missedDeadlinePenalty === 'number'
    ? body.missedDeadlinePenalty
    : LEAGUE_LIMITS.MISSED_DEADLINE_PENALTY_DEFAULT;
  // Team size on majors (migration 026). 4 = same as regular events.
  const majorTeamSize = typeof body.majorTeamSize === 'number' ? body.majorTeamSize : 4;

  // Same validation the form uses client-side — single source of truth.
  // Errors come back as a field-keyed object so the form can highlight
  // the specific input(s) that failed.
  const fieldErrors = validateCreateLeague({
    name, slug, maxPlayers, startDate, endDate, weeklyBetAmount,
    majorBetAmount, payoutPct1, payoutPct2, payoutPct3,
    missedCutPenalty, missedDeadlinePenalty, majorTeamSize,
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
        major_bet_amount:  majorBetAmount === null ? null : majorBetAmount.toFixed(2),
        payout_pct_1:      payoutPct1,
        payout_pct_2:      payoutPct2,
        payout_pct_3:      payoutPct3,
        missed_cut_penalty:      missedCutPenalty,
        missed_deadline_penalty: missedDeadlinePenalty,
        major_team_size:         majorTeamSize,
        // Setup mode: commissioner can adjust rules + prune the schedule
        // until they lock it, or until the first pick deadline passes
        // (src/lib/league-setup.ts).
        setup_status:      'setup',
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

  // ── One-shot ESPN schedule import + per-league schedule seed ──
  // Migration 022 moved the ESPN calendar pull out of the weekly
  // rankings cron and into league creation. If the global tournaments
  // table is empty for this league's window, the import fills it;
  // otherwise the upsert is a near no-op. We then populate the
  // per-league schedule with every non-hidden tournament inside the
  // date window — commissioners can prune from AdminPanel.
  //
  // Import failure is non-fatal — the league row is already committed
  // and members can be added; the commissioner can retry the import
  // via the schedule admin UI. The seed step still runs so any
  // pre-existing tournaments show up in the schedule.
  try {
    await importPGAScheduleFromESPN();
  } catch (err) {
    console.error('League create: ESPN schedule import failed:', err);
  }

  try {
    await db.insertInto('league_tournaments')
      .columns(['league_id', 'tournament_id', 'added_by'])
      .expression(eb => eb
        .selectFrom('tournaments')
        .select(eb2 => [
          eb2.val(league.id).as('league_id'),
          'tournaments.id as tournament_id',
          eb2.val(user.id).as('added_by'),
        ])
        .where('tournaments.hidden', '=', false)
        .$if(!!league.start_date, qb =>
          qb.where('tournaments.start_date', '>=',
            new Date(league.start_date as unknown as string).toISOString()))
        .$if(!!league.end_date, qb =>
          qb.where('tournaments.start_date', '<=',
            new Date(league.end_date as unknown as string).toISOString())),
      )
      .onConflict(oc => oc.doNothing())
      .execute();
  } catch (err) {
    console.error('League create: league_tournaments seed failed:', err);
  }

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
