// ============================================================
// MONEY MATH — per-tournament + per-league cumulative deltas.
//
// Greg's rules (locked 2026-05-17):
//   - Every member of a league bets `weekly_bet_amount` against
//     every other member each tournament.
//   - After the tournament completes, the player(s) at rank 1 split
//     a pot composed of `bet_amount × number_of_losers`. Losers each
//     pay `bet_amount`; the pot splits evenly among co-winners.
//   - A "loser" is anyone who isn't tied for rank 1 — including
//     users with no submitted pick (they bet by joining the league)
//     and users whose total_score is null (e.g. all 4 picks WD/DQ).
//   - If there are zero winners (no rank-1 row at all — e.g. nobody
//     scored), no money changes hands. The pot dissolves.
//
// All functions in this file are pure: no I/O, no clock. Callers
// supply pre-fetched data so unit tests can lock the math down.
// ============================================================

export interface MoneyDelta {
  user_id: string;
  /** Net dollars for this tournament. Positive = won. Negative = lost. */
  amount:  number;
}

export interface TournamentMoneyInput {
  /** Every member of the league at tournament time. Users not in
   *  this list are excluded from the math; users in this list but
   *  missing from `results` are treated as no-pick losers. */
  memberIds: string[];
  /** Fantasy result rows for this tournament. May be sparse — only
   *  contains users who submitted a pick. */
  results: Array<{ user_id: string; rank: number | null }>;
  /** Per-tournament stake in dollars. From `leagues.weekly_bet_amount`. */
  betAmount: number;
}

/**
 * Compute per-user dollar deltas for a single completed tournament.
 * Sum of returned amounts is always zero (money is conserved) when
 * there's at least one winner.
 */
export function computeTournamentMoney(input: TournamentMoneyInput): MoneyDelta[] {
  const { memberIds, results, betAmount } = input;

  // Index results by user_id so we can do quick rank lookups even
  // when results is sparse (no-pick users aren't in the array).
  const rankByUser = new Map<string, number | null>();
  for (const r of results) rankByUser.set(r.user_id, r.rank);

  // Partition members into winners (rank == 1) and everyone else.
  // Users not in results, or with null rank, fall into "loser".
  const winnerIds: string[] = [];
  const loserIds:  string[] = [];
  for (const uid of memberIds) {
    if (rankByUser.get(uid) === 1) winnerIds.push(uid);
    else loserIds.push(uid);
  }

  // Degenerate: nobody finished at rank 1 (every member is no-pick
  // or null-rank). Wash — no money changes hands. Return zeros for
  // every member so callers can rely on the array shape.
  if (winnerIds.length === 0) {
    return memberIds.map(uid => ({ user_id: uid, amount: 0 }));
  }

  const pot       = loserIds.length * betAmount;
  const perWinner = pot / winnerIds.length;

  const isWinner = new Set(winnerIds);
  return memberIds.map(uid => ({
    user_id: uid,
    amount:  isWinner.has(uid) ? perWinner : -betAmount,
  }));
}

// ── League cumulative ────────────────────────────────────────

export interface LeagueMoneyInput {
  memberIds: string[];
  /** One tournament input per completed event. Caller pre-filters to
   *  the league's date range + status='complete'. */
  tournaments: TournamentMoneyInput[];
}

export interface LeagueMoneySummary {
  /** Per-user net across all completed tournaments in the window. */
  totals: MoneyDelta[];
  /** Per-tournament breakdown, in caller-provided order. Each entry
   *  matches the corresponding `tournaments[i]` input. */
  byTournament: MoneyDelta[][];
}

export function computeLeagueMoney(input: LeagueMoneyInput): LeagueMoneySummary {
  const byTournament = input.tournaments.map(t =>
    computeTournamentMoney({ ...t, memberIds: input.memberIds }),
  );

  const totalsByUser = new Map<string, number>();
  for (const uid of input.memberIds) totalsByUser.set(uid, 0);
  for (const deltas of byTournament) {
    for (const d of deltas) {
      totalsByUser.set(d.user_id, (totalsByUser.get(d.user_id) ?? 0) + d.amount);
    }
  }

  return {
    totals: input.memberIds.map(uid => ({
      user_id: uid,
      amount:  totalsByUser.get(uid) ?? 0,
    })),
    byTournament,
  };
}

// ── Display helper ───────────────────────────────────────────

/**
 * Format a dollar amount for display. Negatives wrap in parens
 * matching accounting convention so the leading minus sign doesn't
 * get lost in compact columns. `$0.00` for exact zero.
 */
export function formatMoney(amount: number): string {
  const abs = Math.abs(amount);
  const fixed = abs.toFixed(2);
  if (amount > 0)  return `+$${fixed}`;
  if (amount < 0)  return `-$${fixed}`;
  return `$0.00`;
}
