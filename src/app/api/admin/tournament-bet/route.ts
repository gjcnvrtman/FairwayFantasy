// /api/admin/tournament-bet — commissioner sets or clears the
// per-(league, tournament) bet override (migration 010 / 2026-06-06).
//
// POST { slug, tournamentId, betAmount: number | null }
//   - slug authenticates the requester as a commissioner / co-com of
//     that league. The override is league-scoped — same tournament in
//     a different league is unaffected.
//   - tournamentId names the tournament whose bet we're changing.
//   - betAmount=null clears the override (revert to league default).
//     Any non-null value UPSERTs an override row.
//
// Editability is gated to status='upcoming' tournaments only so we
// don't retroactively shift settled money on active/cut_made/complete
// tournaments. Same call shape Greg confirmed 2026-06-06.
//
// Returns 200 with the resolved bet so the caller can update the UI
// optimistically with the authoritative value.

import { NextRequest, NextResponse } from 'next/server';
import { requireCoCommissionerOrAbove, isAuthFail } from '@/lib/auth-league';
import { db } from '@/lib/db';
import { LEAGUE_LIMITS } from '@/lib/validation';
import { requireSameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const body          = await req.json().catch(() => ({} as Record<string, unknown>));
  const slug          = typeof body.slug         === 'string' ? body.slug         : '';
  const tournamentId  = typeof body.tournamentId === 'string' ? body.tournamentId : '';
  // Tri-state: number = set override; null = clear override; undefined → null.
  const betRaw: unknown = body.betAmount;

  if (!tournamentId) {
    return NextResponse.json({ error: 'tournamentId is required.' }, { status: 400 });
  }

  const auth = await requireCoCommissionerOrAbove({ slug });
  if (isAuthFail(auth)) return auth.response;

  // Validate the tournament exists AND is in 'upcoming' status. The
  // upcoming-only gate is Greg's call so settled / in-flight bets
  // never shift. Status check has to come first — a 400 for a real
  // but locked tournament is clearer than a silent no-op.
  const t = await db.selectFrom('tournaments')
    .select(['id', 'name', 'status'])
    .where('id', '=', tournamentId)
    .executeTakeFirst();
  if (!t) return NextResponse.json({ error: 'Tournament not found.' }, { status: 404 });
  if (t.status !== 'upcoming') {
    return NextResponse.json(
      { error: `Bet can only be changed while a tournament is upcoming (status='${t.status}').` },
      { status: 400 },
    );
  }

  // Bet validation. null = clear; otherwise must be a finite, in-range,
  // ≤2dp number. Same bounds the league-level setting uses.
  let betAmount: number | null = null;
  if (betRaw === null || betRaw === undefined) {
    betAmount = null;
  } else if (typeof betRaw !== 'number' || !Number.isFinite(betRaw)) {
    return NextResponse.json({ error: 'betAmount must be a number or null.' }, { status: 400 });
  } else if (betRaw < LEAGUE_LIMITS.BET_MIN) {
    return NextResponse.json({ error: 'betAmount cannot be negative.' }, { status: 400 });
  } else if (betRaw > LEAGUE_LIMITS.BET_MAX) {
    return NextResponse.json(
      { error: `betAmount cannot exceed $${LEAGUE_LIMITS.BET_MAX}.` },
      { status: 400 },
    );
  } else if (Math.round(betRaw * 100) !== betRaw * 100) {
    return NextResponse.json(
      { error: 'betAmount cannot have more than 2 decimal places.' },
      { status: 400 },
    );
  } else {
    betAmount = betRaw;
  }

  if (betAmount === null) {
    await db.deleteFrom('league_tournament_bets')
      .where('league_id',    '=', auth.league.id)
      .where('tournament_id', '=', tournamentId)
      .execute();
  } else {
    await db.insertInto('league_tournament_bets')
      .values({
        league_id:     auth.league.id,
        tournament_id: tournamentId,
        bet_amount:    betAmount.toFixed(2),
        updated_at:    new Date().toISOString(),
      })
      .onConflict(oc => oc.columns(['league_id', 'tournament_id']).doUpdateSet(eb => ({
        bet_amount: eb.ref('excluded.bet_amount'),
        updated_at: eb.ref('excluded.updated_at'),
      })))
      .execute();
  }

  // Resolve the effective bet so the client can refresh from authoritative
  // values. NULL override → fall back to league default (already on the
  // auth result, no need for a second query).
  const leagueDefault = Number(auth.league.weekly_bet_amount);
  const effective     = betAmount ?? leagueDefault;

  return NextResponse.json({
    ok:               true,
    tournament:       { id: tournamentId, name: t.name },
    league_id:        auth.league.id,
    bet_amount:       betAmount,         // null when reverted to default
    league_default:   leagueDefault,
    effective_bet:    effective,
  });
}
