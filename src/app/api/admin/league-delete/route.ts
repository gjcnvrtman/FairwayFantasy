// /api/admin/league-delete — commissioner-only league deletion.
//
// POST { slug, confirmName }
//   - slug authenticates as a commissioner of THIS league.
//   - confirmName must match league.name exactly (case-sensitive). The
//     UI gates submit on this client-side already; we re-verify
//     server-side so a stale tab or a hand-crafted curl can't slip past.
//   - Refuses delete if the league has any tournament currently in
//     status 'active' or 'cut_made' whose window overlaps the league's
//     date range. Mid-tournament delete would orphan the score-sync
//     timer (it'd keep trying to recompute fantasy_results for a
//     league that no longer exists — currently no-ops since the FK
//     cascade removes the rows, but still messy).
//   - Schema already cascades on every league_id FK (league_members,
//     picks, fantasy_results, season_standings, reminder_log), so a
//     single DELETE removes everything. We log the per-user money
//     totals to the server log at delete time so members have a
//     paper trail.
//
// Returns 200 with { ok: true, deletedLeagueName } on success.
//
// Filed 2026-05-17, shipped 2026-05-19.

import { NextRequest, NextResponse } from 'next/server';
import { requireCommissioner, isAuthFail } from '@/lib/auth-league';
import { db } from '@/lib/db';
import {
  getCompletedTournamentsInRange,
  getEffectiveBetsForTournaments,
  isoOrNull,
} from '@/lib/db/queries';
import { computeLeagueMoney } from '@/lib/money';
import { effectivePickDeadline } from '@/lib/pick-deadline';
import { requireSameOrigin } from '@/lib/same-origin';
import { jsonObjectFrom } from 'kysely/helpers/postgres';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const slug        = typeof body.slug        === 'string' ? body.slug        : '';
  const confirmName = typeof body.confirmName === 'string' ? body.confirmName : '';

  const auth = await requireCommissioner({ slug });
  if (isAuthFail(auth)) return auth.response;

  // ── Server-side confirm check ─────────────────────────────────
  // The Admin UI gates the Delete button on `confirmName === league.name`
  // but we re-verify here so an out-of-date tab or a hand-crafted curl
  // can't accidentally delete the wrong league.
  if (confirmName !== auth.league.name) {
    return NextResponse.json(
      {
        error: `Confirmation name does not match. Type the league's exact name `
             + `("${auth.league.name}") to confirm deletion.`,
      },
      { status: 400 },
    );
  }

  // ── Guard: refuse delete if a tournament is currently mid-event ──
  // 'active' = round in progress; 'cut_made' = post-cut, still scoring.
  // Either state means the score-sync timer could be mid-cycle for this
  // league when we yank the row out from under it. Cleaner to require
  // post-event before delete. Manual override path: commissioner can
  // wait, OR force-flip the tournament's status to 'complete' via the
  // existing maintenance sweep. Keeps the destructive action firmly
  // out of the live-trading window.
  const lgStart = isoOrNull(auth.league.start_date);
  const lgEnd   = isoOrNull(auth.league.end_date);
  // Per-league schedule (migration 022): only refuse if a tournament
  // in THIS league's schedule is live. Another league's live event
  // is none of our business.
  const activeInRange = await db.selectFrom('tournaments')
    .innerJoin('league_tournaments', 'league_tournaments.tournament_id', 'tournaments.id')
    .select(['tournaments.id', 'tournaments.name', 'tournaments.status'])
    .where('league_tournaments.league_id', '=', auth.league.id)
    .where('tournaments.status', 'in', ['active', 'cut_made'])
    .execute();
  if (activeInRange.length > 0) {
    const tourneys = activeInRange.map(t => `${t.name} (${t.status})`).join(', ');
    return NextResponse.json(
      {
        error: `Cannot delete league while a tournament is in progress: ${tourneys}. `
             + `Wait until it completes, or have it manually flipped to 'complete' first.`,
      },
      { status: 409 },
    );
  }

  // ── Audit trail: log per-user money totals before the wipe ──
  // No settlement system today, so deletion is also the only way some
  // members will see what they "owed" or "won." Snapshot to server log
  // so anyone debugging in journalctl can reconstruct after-the-fact.
  try {
    const members = await db.selectFrom('league_members')
      .select(['user_id', 'joined_at'])
      .where('league_id', '=', auth.league.id)
      .execute();

    const completed = await getCompletedTournamentsInRange(auth.league.id, lgStart, lgEnd);
    const tournamentResults = await Promise.all(
      completed.map(async t => {
        const results = await db.selectFrom('fantasy_results')
          .selectAll('fantasy_results')
          .select(eb => jsonObjectFrom(
            eb.selectFrom('profiles')
              .select('display_name')
              .whereRef('profiles.id', '=', 'fantasy_results.user_id'),
          ).as('profile'))
          .where('league_id',     '=', auth.league.id)
          .where('tournament_id', '=', t.id)
          .orderBy('rank', 'asc')
          .execute();
        return { tournament: t, results };
      }),
    );
    const withResults = tournamentResults.filter(t => t.results.length > 0);

    const betAmount = Number(auth.league.weekly_bet_amount ?? 0);
    const moneyMembers = members.map(m => ({
      user_id:   m.user_id,
      joined_at: m.joined_at,
    }));
    // Per-tournament bet overrides (migration 010); fall back to the
    // league default for any tournament without an explicit override.
    const effectiveBets = await getEffectiveBetsForTournaments(
      auth.league.id, withResults.map(t => t.tournament.id), betAmount,
    );
    const moneySummary = computeLeagueMoney({
      members: moneyMembers,
      tournaments: withResults.map(({ tournament: t, results }) => ({
        lockedAt:  effectivePickDeadline(t) ?? t.start_date,
        betAmount: effectiveBets.get(t.id) ?? betAmount,
        results:   results.map(r => ({ user_id: r.user_id, rank: r.rank })),
      })),
    });

    console.log(
      `[league-delete] league="${auth.league.name}" slug="${slug}" ` +
      `commissioner=${auth.user.id} member_count=${members.length} ` +
      `completed_tournaments=${withResults.length} ` +
      `bet_amount=$${betAmount.toFixed(2)} ` +
      `totals=${JSON.stringify(moneySummary.totals)}`,
    );
  } catch (e) {
    // Audit failure must not block the delete itself — log it but
    // proceed. The DELETE is the user's explicit ask; we shouldn't
    // hold it hostage to a side-effect we added for our own benefit.
    console.warn(`[league-delete] audit-log failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── The actual deletion ────────────────────────────────────────
  // ON DELETE CASCADE on league_id FKs handles every dependent row.
  await db.deleteFrom('leagues')
    .where('id', '=', auth.league.id)
    .execute();

  return NextResponse.json({
    ok: true,
    deletedLeagueName: auth.league.name,
  });
}
