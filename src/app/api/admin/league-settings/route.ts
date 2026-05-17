// /api/admin/league-settings — commissioner-only league-config edits.
//
// POST { slug, maxPlayers?, startDate?, endDate?, weeklyBetAmount? }
//   - slug authenticates as a commissioner of THIS league.
//   - Any of the four field params can be present; absent fields are
//     not touched. At least one supported field must be provided.
//   - maxPlayers — bounded by LEAGUE_LIMITS, cannot drop below the
//     current member count.
//   - startDate / endDate — ISO-8601 yyyy-mm-dd. Either may be set on
//     its own; if both are set the relationship is end >= start.
//     null clears the column (back to unbounded).
//   - weeklyBetAmount — bounded by LEAGUE_LIMITS.BET_MIN..BET_MAX.
//     ≤2 decimal places.
//
// Returns 200 with the updated league row on success, 400 with a
// human-readable error on validation failure.

import { NextRequest, NextResponse } from 'next/server';
import { requireCommissioner, isAuthFail } from '@/lib/auth-league';
import { db } from '@/lib/db';
import { LEAGUE_LIMITS } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const slug             = typeof body.slug === 'string' ? body.slug : '';
  const maxPlayersRaw    = body.maxPlayers;
  const startDateRaw     = body.startDate;
  const endDateRaw       = body.endDate;
  const weeklyBetAmtRaw  = body.weeklyBetAmount;

  const auth = await requireCommissioner({ slug });
  if (isAuthFail(auth)) return auth.response;

  // ── Collect updates ──
  // Any field that's absent (undefined) stays untouched. Explicit null
  // on a date field means "clear the column".
  const updates: Record<string, number | string | null> = {};

  // maxPlayers
  if (maxPlayersRaw !== undefined) {
    if (typeof maxPlayersRaw !== 'number' || !Number.isInteger(maxPlayersRaw)) {
      return NextResponse.json({ error: 'maxPlayers must be an integer.' }, { status: 400 });
    }
    if (maxPlayersRaw < LEAGUE_LIMITS.MAX_PLAYERS_MIN) {
      return NextResponse.json(
        { error: `Max players must be at least ${LEAGUE_LIMITS.MAX_PLAYERS_MIN}.` },
        { status: 400 },
      );
    }
    if (maxPlayersRaw > LEAGUE_LIMITS.MAX_PLAYERS_MAX) {
      return NextResponse.json(
        { error: `Max players must be ${LEAGUE_LIMITS.MAX_PLAYERS_MAX} or fewer.` },
        { status: 400 },
      );
    }
    const memberCountRow = await db.selectFrom('league_members')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('league_id', '=', auth.league.id)
      .executeTakeFirstOrThrow();
    const currentMembers = Number(memberCountRow.n);
    if (maxPlayersRaw < currentMembers) {
      return NextResponse.json(
        {
          error: `Cannot set max players to ${maxPlayersRaw} — league currently has `
               + `${currentMembers} member(s). Remove members first.`,
        },
        { status: 400 },
      );
    }
    updates.max_players = maxPlayersRaw;
  }

  // startDate
  let startISO: string | null | undefined;
  if (startDateRaw !== undefined) {
    if (startDateRaw === null || startDateRaw === '') {
      startISO = null;
    } else if (typeof startDateRaw === 'string' && ISO_DATE_RE.test(startDateRaw)) {
      const d = new Date(startDateRaw + 'T00:00:00Z');
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: 'Invalid start date.' }, { status: 400 });
      }
      startISO = d.toISOString();
    } else {
      return NextResponse.json(
        { error: 'startDate must be yyyy-mm-dd or null.' },
        { status: 400 },
      );
    }
  }

  // endDate
  let endISO: string | null | undefined;
  if (endDateRaw !== undefined) {
    if (endDateRaw === null || endDateRaw === '') {
      endISO = null;
    } else if (typeof endDateRaw === 'string' && ISO_DATE_RE.test(endDateRaw)) {
      const d = new Date(endDateRaw + 'T23:59:59Z');
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: 'Invalid end date.' }, { status: 400 });
      }
      endISO = d.toISOString();
    } else {
      return NextResponse.json(
        { error: 'endDate must be yyyy-mm-dd or null.' },
        { status: 400 },
      );
    }
  }

  // Cross-field: end must be >= start. Compute the effective values
  // (incoming change OR existing value) so a single-field update can
  // still be validated against the stored counterpart.
  const effectiveStart = startISO === undefined ? auth.league.start_date : startISO;
  const effectiveEnd   = endISO   === undefined ? auth.league.end_date   : endISO;
  if (effectiveStart && effectiveEnd && new Date(effectiveEnd) < new Date(effectiveStart)) {
    return NextResponse.json(
      { error: 'End date must be on or after start date.' },
      { status: 400 },
    );
  }
  if (startISO !== undefined) updates.start_date = startISO;
  if (endISO   !== undefined) updates.end_date   = endISO;

  // weeklyBetAmount
  if (weeklyBetAmtRaw !== undefined) {
    if (typeof weeklyBetAmtRaw !== 'number' || !Number.isFinite(weeklyBetAmtRaw)) {
      return NextResponse.json({ error: 'weeklyBetAmount must be a number.' }, { status: 400 });
    }
    if (weeklyBetAmtRaw < LEAGUE_LIMITS.BET_MIN) {
      return NextResponse.json({ error: 'weeklyBetAmount cannot be negative.' }, { status: 400 });
    }
    if (weeklyBetAmtRaw > LEAGUE_LIMITS.BET_MAX) {
      return NextResponse.json(
        { error: `weeklyBetAmount cannot exceed $${LEAGUE_LIMITS.BET_MAX}.` },
        { status: 400 },
      );
    }
    if (Math.round(weeklyBetAmtRaw * 100) !== weeklyBetAmtRaw * 100) {
      return NextResponse.json(
        { error: 'weeklyBetAmount cannot have more than 2 decimal places.' },
        { status: 400 },
      );
    }
    updates.weekly_bet_amount = weeklyBetAmtRaw.toFixed(2);
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: 'No supported settings field was provided.' },
      { status: 400 },
    );
  }

  await db.updateTable('leagues')
    .set(updates as any)
    .where('id', '=', auth.league.id)
    .execute();

  const updated = await db.selectFrom('leagues')
    .select(['id', 'slug', 'name', 'max_players',
             'start_date', 'end_date', 'weekly_bet_amount'])
    .where('id', '=', auth.league.id)
    .executeTakeFirstOrThrow();

  return NextResponse.json({ ok: true, league: updated });
}
