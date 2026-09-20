// ============================================================
// MONEY MATH — per-tournament + per-league cumulative deltas.
//
// Greg's rules:
//   - Every member of a league at tournament-lock-time antes
//     `weekly_bet_amount`. Members who joined AFTER the picks locked
//     don't participate in that tournament's pot (refined 2026-05-17
//     after Greg saw a fresh signup get charged for a tournament
//     that finished before they ever joined).
//   - The pot (`eligible × bet_amount`) distributes across the top
//     3 finishers per the league's `payout_pct_1/2/3` config
//     (migration 023, 2026-09-20). Default 100/0/0 = winner-take-all,
//     which reproduces the pre-023 pot-of-losses behavior exactly.
//   - Ties resolve by the PGA combined-share rule: K players tied at
//     rank R occupy ranks R..R+K-1; the payout percentages for those
//     ranks (bounded by the paid top 3) get combined and split
//     evenly among the K. Pot is always fully distributed as long as
//     someone is at rank 1.
//   - If nobody is at rank 1 (e.g. all picks null / all withdrew),
//     no money changes hands. The pot dissolves.
//
// All functions in this file are pure: no I/O, no clock. Callers
// supply pre-fetched data so unit tests can lock the math down.
// ============================================================

/** Top-3 payout split. All fields are integer percentages 0..100
 *  and must sum to exactly 100. Enforced at the DB level by
 *  migration 023's CHECK constraints; callers should still validate
 *  before persisting. */
export interface PayoutStructure {
  pct1: number;
  pct2: number;
  pct3: number;
}

/** Winner-take-all default. Matches pre-migration-023 behavior. */
export const PAYOUT_WINNER_TAKE_ALL: PayoutStructure = {
  pct1: 100, pct2: 0, pct3: 0,
};

/** Extract a PayoutStructure from a league row. Convenience for the
 *  four money-math callers so they don't repeat the same 3-line
 *  destructure. `payout_pct_*` columns are INTEGER (migration 023),
 *  so the pg driver hands them back as JS numbers already. */
export function payoutFromLeague(league: {
  payout_pct_1: number;
  payout_pct_2: number;
  payout_pct_3: number;
}): PayoutStructure {
  return {
    pct1: league.payout_pct_1,
    pct2: league.payout_pct_2,
    pct3: league.payout_pct_3,
  };
}

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
   *  (migration 010, 2026-06-06). */
  betAmount: number;
  /** Payout split (migration 023). Defaults to winner-take-all so
   *  existing callers keep working; new callers should pass the
   *  league's actual `payout_pct_*` values. */
  payout?:   PayoutStructure;
}

/** Coerce ISO-string-or-Date to a numeric epoch for comparison. */
function ts(v: string | Date): number {
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

/**
 * Compute per-user dollar deltas for a single completed tournament.
 *
 * Returns one entry per CURRENT member (so callers can keep a stable
 * shape across tournaments), with `amount: 0` for members who weren't
 * in the league when picks locked. Sum of nonzero amounts is always
 * zero (money is conserved) when there's at least one winner.
 *
 * Algorithm (PGA combined-share tie rule):
 *   1. pot = eligible × betAmount.
 *   2. Group eligible-with-non-null-rank users by rank.
 *   3. Walk ranks ascending. For each rank R with K tied users:
 *        - Combined share = Σ payout.pct{R..R+K-1} (only ranks 1..3
 *          contribute — 4+ contribute 0).
 *        - Each of the K gets (pot × combinedPct / 100 / K) gross.
 *   4. Each eligible member's net = gross - betAmount (their ante).
 *   5. Members who joined after lockedAt return amount: 0 (untouched).
 *
 * Invariants:
 *   - When rank 1 exists AND league has ≥ 3 eligible members with
 *     ranks 1/2/3 populated (no ties), sum(amount) == 0.
 *   - Wider ties still fully distribute the pot as long as rank 1
 *     is filled — the combined-share rule guarantees ranks 1-3's
 *     percentages get paid out to whoever occupies those positions.
 *   - When no rank 1 exists, all amounts are 0 (pot dissolves).
 */
export function computeTournamentMoney(input: TournamentMoneyInput): MoneyDelta[] {
  const { members, lockedAt, results, betAmount } = input;
  const payout = input.payout ?? PAYOUT_WINNER_TAKE_ALL;
  const lockMs = ts(lockedAt);

  const rankByUser = new Map<string, number | null>();
  for (const r of results) rankByUser.set(r.user_id, r.rank);

  // Only members who joined before/at lockedAt participate.
  const eligible: string[] = [];
  for (const m of members) {
    if (ts(m.joined_at) <= lockMs) eligible.push(m.user_id);
  }

  // Degenerate: no rank-1 finisher (nobody scored or all picks null).
  const anyRank1 = eligible.some(uid => rankByUser.get(uid) === 1);
  if (!anyRank1) {
    return members.map(m => ({ user_id: m.user_id, amount: 0 }));
  }

  const pot = eligible.length * betAmount;

  // Group eligible users with non-null rank by their rank.
  const usersAtRank = new Map<number, string[]>();
  for (const uid of eligible) {
    const r = rankByUser.get(uid);
    if (r == null) continue;
    const bucket = usersAtRank.get(r);
    if (bucket) bucket.push(uid); else usersAtRank.set(r, [uid]);
  }

  // Payout percentage by rank — only ranks 1..3 pay; anything else 0.
  const pctForRank = (r: number): number =>
    r === 1 ? payout.pct1
    : r === 2 ? payout.pct2
    : r === 3 ? payout.pct3
    : 0;

  // Compute gross payout per user. PGA combined-share: K tied at rank
  // R occupy ranks R..R+K-1; sum the payout percentages for that
  // window (paid ranks contribute their %, unpaid ranks contribute 0),
  // then split evenly among the K users.
  const grossByUser = new Map<string, number>();
  const sortedRanks = [...usersAtRank.keys()].sort((a, b) => a - b);
  for (const r of sortedRanks) {
    const usersHere = usersAtRank.get(r)!;
    const k = usersHere.length;
    let combinedPct = 0;
    for (let i = 0; i < k; i++) combinedPct += pctForRank(r + i);
    if (combinedPct === 0) continue;
    const grossPerUser = (pot * combinedPct) / 100 / k;
    for (const uid of usersHere) grossByUser.set(uid, grossPerUser);
  }

  const isEligible = new Set(eligible);
  return members.map(m => {
    if (!isEligible.has(m.user_id)) return { user_id: m.user_id, amount: 0 };
    const gross = grossByUser.get(m.user_id) ?? 0;
    return { user_id: m.user_id, amount: gross - betAmount };
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
   *  carries its own `lockedAt` (the picks-locked timestamp). A
   *  per-tournament `payout` override is allowed but rarely used;
   *  falls back to the league-level `payout` below, then to
   *  winner-take-all. */
  tournaments: Array<{
    lockedAt:  string | Date;
    results:   Array<{ user_id: string; rank: number | null }>;
    betAmount: number;
    payout?:   PayoutStructure;
  }>;
  /** League-level payout split. Applies to every tournament that
   *  doesn't carry its own override. Defaults to winner-take-all
   *  so existing callers keep working. */
  payout?: PayoutStructure;
}

export interface LeagueMoneySummary {
  /** Per-user net across all completed tournaments in the window. */
  totals: MoneyDelta[];
  /** Per-tournament breakdown, in caller-provided order. Each entry
   *  matches the corresponding `tournaments[i]` input. */
  byTournament: MoneyDelta[][];
}

export function computeLeagueMoney(input: LeagueMoneyInput): LeagueMoneySummary {
  const leaguePayout = input.payout ?? PAYOUT_WINNER_TAKE_ALL;
  const byTournament = input.tournaments.map(t =>
    computeTournamentMoney({
      members:   input.members,
      lockedAt:  t.lockedAt,
      results:   t.results,
      betAmount: t.betAmount,
      payout:    t.payout ?? leaguePayout,
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
