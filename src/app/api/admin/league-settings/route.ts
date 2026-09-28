// /api/admin/league-settings — commissioner-only league-config edits.
//
// POST { slug, maxPlayers?, startDate?, endDate?, weeklyBetAmount?,
//        payoutPct1?, payoutPct2?, payoutPct3? }
//   - slug authenticates as a commissioner of THIS league.
//   - Any of the supported params can be present; absent fields are
//     not touched. At least one supported field must be provided.
//   - maxPlayers — bounded by LEAGUE_LIMITS, cannot drop below the
//     current member count.
//   - startDate / endDate — ISO-8601 yyyy-mm-dd. Either may be set on
//     its own; if both are set the relationship is end >= start.
//     null clears the column (back to unbounded).
//   - weeklyBetAmount — bounded by LEAGUE_LIMITS.BET_MIN..BET_MAX.
//     ≤2 decimal places.
//   - payoutPct1/2/3 — integers 0..100 that must sum to 100. Must be
//     supplied as a set (all three or none); we don't allow updating
//     one at a time since the sum invariant would break mid-write.
//   - majorBetAmount (number | null), missedCutPenalty,
//     missedDeadlinePenalty — setup-mode leagues only (migration 025).
//
// Setup lifecycle (src/lib/league-setup.ts): once a league is locked
// only maxPlayers can change.
//
// Returns 200 with the updated league row on success, 400 with a
// human-readable error on validation failure.

import { NextRequest, NextResponse } from 'next/server';
import { requireCommissioner, isAuthFail } from '@/lib/auth-league';
import { db } from '@/lib/db';
import { LEAGUE_LIMITS, validateCreateLeague } from '@/lib/validation';
import { requireSameOrigin } from '@/lib/same-origin';
import { resolveSetupStatus } from '@/lib/league-setup';

export const dynamic = 'force-dynamic';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class SetupLockedError extends Error {}

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const slug             = typeof body.slug === 'string' ? body.slug : '';
  const maxPlayersRaw    = body.maxPlayers;
  const startDateRaw     = body.startDate;
  const endDateRaw       = body.endDate;
  const weeklyBetAmtRaw  = body.weeklyBetAmount;
  const payoutPct1Raw    = body.payoutPct1;
  const payoutPct2Raw    = body.payoutPct2;
  const payoutPct3Raw    = body.payoutPct3;
  const majorBetRaw      = body.majorBetAmount;
  const mcPenaltyRaw     = body.missedCutPenalty;
  const mdPenaltyRaw     = body.missedDeadlinePenalty;
  const teamSizeRaw      = body.majorTeamSize;

  const auth = await requireCommissioner({ slug });
  if (isAuthFail(auth)) return auth.response;

  const setupStatus = await resolveSetupStatus(auth.league);

  // Locked leagues: only max players stays editable.
  if (setupStatus === 'locked') {
    const lockedFields = [
      startDateRaw, endDateRaw, weeklyBetAmtRaw,
      payoutPct1Raw, payoutPct2Raw, payoutPct3Raw,
      majorBetRaw, mcPenaltyRaw, mdPenaltyRaw, teamSizeRaw,
    ];
    if (lockedFields.some(v => v !== undefined)) {
      return NextResponse.json(
        { error: 'This league’s setup is locked — rules can’t be changed.' },
        { status: 409 },
      );
    }
  }

  // ── Collect updates ──
  // Any field that's absent (undefined) stays untouched. Explicit null
  // on a date field means "clear the column".
  const updates: Record<string, number | string | null> = {};

  // Setup-only rules (majors bet + penalties). Legacy leagues keep
  // their pre-025 behavior and never expose these.
  const setupRuleTouched =
    majorBetRaw !== undefined || mcPenaltyRaw !== undefined ||
    mdPenaltyRaw !== undefined || teamSizeRaw !== undefined;
  if (setupRuleTouched) {
    if (setupStatus !== 'setup') {
      return NextResponse.json(
        { error: 'Majors bet, team size and penalties can only be set on leagues created with the new setup.' },
        { status: 400 },
      );
    }
    if (teamSizeRaw !== undefined) {
      if (teamSizeRaw !== 4 && teamSizeRaw !== 6) {
        return NextResponse.json({ error: 'Majors team size must be 4 or 6.' }, { status: 400 });
      }
      updates.major_team_size = teamSizeRaw;
    }
    // Reuse the create-form validator for these three fields.
    const errs = validateCreateLeague({
      name: auth.league.name, slug: auth.league.slug,
      maxPlayers: auth.league.max_players,
      startDate: '2000-01-01', endDate: '2000-01-01',
      weeklyBetAmount: Number(auth.league.weekly_bet_amount),
      majorBetAmount: majorBetRaw === undefined ? undefined : majorBetRaw as number | null,
      missedCutPenalty: mcPenaltyRaw === undefined ? undefined : mcPenaltyRaw as number,
      missedDeadlinePenalty: mdPenaltyRaw === undefined ? undefined : mdPenaltyRaw as number,
    });
    const firstErr = errs.majorBetAmount ?? errs.missedCutPenalty ?? errs.missedDeadlinePenalty;
    if (firstErr) return NextResponse.json({ error: firstErr }, { status: 400 });
    if (majorBetRaw !== undefined) {
      updates.major_bet_amount = majorBetRaw === null ? null : (majorBetRaw as number).toFixed(2);
    }
    if (mcPenaltyRaw !== undefined) updates.missed_cut_penalty      = mcPenaltyRaw as number;
    if (mdPenaltyRaw !== undefined) updates.missed_deadline_penalty = mdPenaltyRaw as number;
  }

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

  // payoutPct1/2/3 — must be supplied as a set. Reject partial to
  // avoid a mid-write state that violates the sum-to-100 invariant.
  const payoutTouched =
    payoutPct1Raw !== undefined ||
    payoutPct2Raw !== undefined ||
    payoutPct3Raw !== undefined;
  if (payoutTouched) {
    if (
      payoutPct1Raw === undefined ||
      payoutPct2Raw === undefined ||
      payoutPct3Raw === undefined
    ) {
      return NextResponse.json(
        { error: 'payoutPct1, payoutPct2, and payoutPct3 must all be provided together.' },
        { status: 400 },
      );
    }
    const p1 = payoutPct1Raw, p2 = payoutPct2Raw, p3 = payoutPct3Raw;
    for (const [name, v] of [['payoutPct1', p1], ['payoutPct2', p2], ['payoutPct3', p3]] as const) {
      if (typeof v !== 'number' || !Number.isInteger(v)) {
        return NextResponse.json(
          { error: `${name} must be an integer.` },
          { status: 400 },
        );
      }
      if (v < 0 || v > 100) {
        return NextResponse.json(
          { error: `${name} must be between 0 and 100.` },
          { status: 400 },
        );
      }
    }
    if ((p1 as number) + (p2 as number) + (p3 as number) !== 100) {
      return NextResponse.json(
        { error: 'payoutPct1 + payoutPct2 + payoutPct3 must equal 100.' },
        { status: 400 },
      );
    }
    updates.payout_pct_1 = p1 as number;
    updates.payout_pct_2 = p2 as number;
    updates.payout_pct_3 = p3 as number;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: 'No supported settings field was provided.' },
      { status: 400 },
    );
  }

  // Payout freeze rule (migration 024): when the payout split
  // changes, snapshot the OLD league-level values for every
  // tournament in this league whose picks are already locked, so
  // history displays don't retroactively rewrite. ON CONFLICT DO
  // NOTHING means a tournament that was already snapshotted from
  // an earlier edit keeps its earlier (older) frozen value —
  // exactly the "going forward only" semantic Greg specified.
  //
  // Wrapped in a transaction so a snapshot failure aborts the
  // league update, and a concurrent read can't observe the new
  // league values before its own tournament's snapshot exists.
  const payoutChanged = payoutTouched && (
    (updates.payout_pct_1 as number) !== auth.league.payout_pct_1 ||
    (updates.payout_pct_2 as number) !== auth.league.payout_pct_2 ||
    (updates.payout_pct_3 as number) !== auth.league.payout_pct_3
  );

  const lockedMidRequest = await db.transaction().execute(async (trx) => {
    if (payoutChanged) {
      // Snapshot OLD values for every past-lock tournament in this
      // league's schedule that doesn't already have a snapshot.
      // COALESCE picks the override deadline when set (per
      // effectivePickDeadline in @/lib/pick-deadline).
      await trx.insertInto('league_tournament_payouts')
        .columns([
          'league_id', 'tournament_id',
          'payout_pct_1', 'payout_pct_2', 'payout_pct_3',
        ])
        .expression(eb => eb.selectFrom('league_tournaments as lt')
          .innerJoin('tournaments as t', 't.id', 'lt.tournament_id')
          .select(eb2 => [
            'lt.league_id',
            'lt.tournament_id',
            eb2.val(auth.league.payout_pct_1).as('payout_pct_1'),
            eb2.val(auth.league.payout_pct_2).as('payout_pct_2'),
            eb2.val(auth.league.payout_pct_3).as('payout_pct_3'),
          ])
          .where('lt.league_id', '=', auth.league.id)
          .where(eb2 => eb2.fn.coalesce(
            eb2.ref('t.pick_deadline_override'),
            eb2.ref('t.pick_deadline'),
          ), '<', new Date().toISOString()),
        )
        .onConflict(oc => oc
          .columns(['league_id', 'tournament_id'])
          .doNothing(),
        )
        .execute();
    }

    // Setup-mode rule edits only apply while the league is STILL in
    // setup — closes the race with a lock landing mid-request. A miss
    // throws, rolling back the whole transaction.
    const ruleEdit = setupStatus === 'setup'
      && Object.keys(updates).some(k => k !== 'max_players');
    const res = await trx.updateTable('leagues')
      .set(updates as any)
      .where('id', '=', auth.league.id)
      .$if(ruleEdit, qb => qb.where('setup_status', '=', 'setup'))
      .executeTakeFirst();
    if (ruleEdit && Number(res.numUpdatedRows) === 0) throw new SetupLockedError();
    return 'ok' as const;
  }).catch(err => {
    if (err instanceof SetupLockedError) return 'locked' as const;
    throw err;
  });

  if (lockedMidRequest === 'locked') {
    return NextResponse.json(
      { error: 'This league’s setup just locked — rules can’t be changed.' },
      { status: 409 },
    );
  }

  const updated = await db.selectFrom('leagues')
    .select(['id', 'slug', 'name', 'max_players',
             'start_date', 'end_date', 'weekly_bet_amount',
             'payout_pct_1', 'payout_pct_2', 'payout_pct_3',
             'major_bet_amount', 'missed_cut_penalty',
             'missed_deadline_penalty', 'major_team_size', 'setup_status'])
    .where('id', '=', auth.league.id)
    .executeTakeFirstOrThrow();

  return NextResponse.json({ ok: true, league: updated });
}
