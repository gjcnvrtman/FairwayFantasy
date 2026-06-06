// ============================================================
// MONEY MATH — per-tournament + per-league cumulative deltas.
//
// Greg's rules (locked 2026-05-17):
//   - Every member of a league at tournament-lock-time bets
//     `weekly_bet_amount` against every other member at lock-time.
//     Members who joined AFTER the picks locked don't participate
//     in that tournament's pot (refined 2026-05-17 after Greg saw
//     a fresh signup get charged for a tournament that finished
//     before they ever joined).
//   - After the tournament completes, the player(s) at rank 1 split
//     a pot composed of `bet_amount × number_of_losers`. Losers each
//     pay `bet_amount`; the pot splits evenly among co-winners.
//   - A "loser" is anyone who isn't tied for rank 1 — including
//     users with no submitted pick (they bet by joining the league
//     in time) and users whose total_score is null (e.g. all 4
//     picks WD/DQ).
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

export interface MoneyMember {
  user_id:   string;
  /** When this member joined the league. ISO string or Date — the
   *  helper accepts either. Used to filter members out of tournaments
   *  whose pick-lock time was BEFORE the member joined. */
  joined_at: string | Date;
}

export interface TournamentMoneyInput {
  /** Every current member of the league. The helper internally
   *  filters down to members whose `joined_at` is ≤ `lockedAt`. */
  members:   MoneyMember[];
  /** When this tournament's picks locked. Members who joined AFTER
   *  this moment are excluded from the bet pool — they hadn't yet
   *  agreed to participate when bets were placed. ISO or Date. */
  lockedAt:  string | Date;
  /** Fantasy result rows for this tournament. May be sparse — only
   *  contains users who submitted a pick. */
  results: Array<{ user_id: string; rank: number | null }>;
  /** Per-tournament stake in dollars. Resolved by the caller as
   *  `league_tournament_bets.bet_amount ?? leagues.weekly_bet_amount`
   *  (migration 010, 2026-06-06). Different tournaments in the same
   *  league can carry different stakes when a commissioner overrides
   *  the league default for a specific upcoming tournament. */
  betAmount: number;
}

/** Coerce ISO-string-or-Date to a numeric epoch for comparison. */
function ts(v: string | Date): number {
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

/**
 * Compute per-user dollar deltas for a single completed tournament.
 * Returns one entry per CURRENT member (so callers can keep a stable
 * shape across tournaments), with `amount: 0` for members who weren't
 * in the league when picks locked. Sum of nonzero amounts is always
 * zero (money is conserved) when there's at least one winner.
 */
export function computeTournamentMoney(input: TournamentMoneyInput): MoneyDelta[] {
  const { members, lockedAt, results, betAmount } = input;
  const lockMs = ts(lockedAt);

  const rankByUser = new Map<string, number | null>();
  for (const r of results) rankByUser.set(r.user_id, r.rank);

  // Only members who joined before/at lockedAt participate.
  // Members who joined later get amount: 0 (still in the returned
  // array so the caller's order is preserved).
  const eligible: string[] = [];
  for (const m of members) {
    if (ts(m.joined_at) <= lockMs) eligible.push(m.user_id);
  }

  const winnerIds: string[] = [];
  const loserIds:  string[] = [];
  for (const uid of eligible) {
    if (rankByUser.get(uid) === 1) winnerIds.push(uid);
    else loserIds.push(uid);
  }

  // Degenerate: nobody at rank 1 (or no eligible members at all).
  if (winnerIds.length === 0) {
    return members.map(m => ({ user_id: m.user_id, amount: 0 }));
  }

  const pot       = loserIds.length * betAmount;
  const perWinner = pot / winnerIds.length;
  const isEligible = new Set(eligible);
  const isWinner   = new Set(winnerIds);

  return members.map(m => {
    if (!isEligible.has(m.user_id)) return { user_id: m.user_id, amount: 0 };
    return {
      user_id: m.user_id,
      amount:  isWinner.has(m.user_id) ? perWinner : -betAmount,
    };
  });
}

// ── League cumulative ────────────────────────────────────────

export interface LeagueMoneyInput {
  /** Current league members. Each must carry a joined_at so the
   *  per-tournament filter can exclude late joiners from older
   *  tournaments. */
  members: MoneyMember[];
  /** One tournament input per completed event. Caller pre-filters to
   *  the league's date range + status='complete'. Each tournament
   *  carries its own `lockedAt` (the picks-locked timestamp). */
  tournaments: Array<{
    lockedAt:  string | Date;
    results:   Array<{ user_id: string; rank: number | null }>;
    betAmount: number;
  }>;
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
    computeTournamentMoney({
      members:   input.members,
      lockedAt:  t.lockedAt,
      results:   t.results,
      betAmount: t.betAmount,
    }),
  );

  const totalsByUser = new Map<string, number>();
  for (const m of input.members) totalsByUser.set(m.user_id, 0);
  for (const deltas of byTournament) {
    for (const d of deltas) {
      totalsByUser.set(d.user_id, (totalsByUser.get(d.user_id) ?? 0) + d.amount);
    }
  }

  return {
    totals: input.members.map(m => ({
      user_id: m.user_id,
      amount:  totalsByUser.get(m.user_id) ?? 0,
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
