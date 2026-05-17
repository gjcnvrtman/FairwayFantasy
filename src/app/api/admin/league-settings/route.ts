// /api/admin/league-settings — commissioner-only league-config edits.
//
// POST { slug, maxPlayers? }
//   - slug authenticates as a commissioner of THIS league.
//   - maxPlayers (if provided) replaces leagues.max_players. Must stay
//     within LEAGUE_LIMITS bounds AND cannot drop below the current
//     member count (would leave the league over-capacity).
//
// Returns 200 with the updated league row on success, 400 with a
// human-readable error on validation failure.

import { NextRequest, NextResponse } from 'next/server';
import { requireCommissioner, isAuthFail } from '@/lib/auth-league';
import { db } from '@/lib/db';
import { LEAGUE_LIMITS } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const slug = typeof body.slug === 'string' ? body.slug : '';
  const maxPlayersRaw = body.maxPlayers;

  const auth = await requireCommissioner({ slug });
  if (isAuthFail(auth)) return auth.response;

  // Only field supported today is maxPlayers. Omit-or-undefined = noop.
  if (maxPlayersRaw === undefined) {
    return NextResponse.json(
      { error: 'No supported settings field was provided.' },
      { status: 400 },
    );
  }
  if (typeof maxPlayersRaw !== 'number' || !Number.isInteger(maxPlayersRaw)) {
    return NextResponse.json(
      { error: 'maxPlayers must be an integer.' },
      { status: 400 },
    );
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

  // Can't shrink below the current member count — would render the
  // league instantly over-capacity. Operator must remove members first.
  const memberCountRow = await db.selectFrom('league_members')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('league_id', '=', auth.league.id)
    .executeTakeFirstOrThrow();
  const currentMembers = Number(memberCountRow.n);
  if (maxPlayersRaw < currentMembers) {
    return NextResponse.json(
      {
        error:
          `Cannot set max players to ${maxPlayersRaw} — league currently has ` +
          `${currentMembers} member(s). Remove members first.`,
      },
      { status: 400 },
    );
  }

  await db.updateTable('leagues')
    .set({ max_players: maxPlayersRaw })
    .where('id', '=', auth.league.id)
    .execute();

  const updated = await db.selectFrom('leagues')
    .select(['id', 'slug', 'name', 'max_players'])
    .where('id', '=', auth.league.id)
    .executeTakeFirstOrThrow();

  return NextResponse.json({ ok: true, league: updated });
}
