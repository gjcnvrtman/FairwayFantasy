// ============================================================
// SEASON BETS (migration 027) — pure calculation engine.
//
// Seasons: a league's scheduled tournaments, in start-date order,
// split evenly into 1..4 seasons (extras go to the earlier seasons).
//
// Cumulative bets, settled once every tournament in the season is
// complete. Each eligible member bets the league's amount; the lowest
// total (it's golf) takes the whole pot, ties split it. $10 × 20
// players → the winner nets +$190, everyone else −$10. Zero-sum.
// Each season is its own pot.
//   team       — every golfer on the team (6 on 6-man majors)
//   topTier    — top-tier slots only
//   darkHorse  — dark-horse slots only
// A golfer's contribution is their score to par for the event; a
// missed-cut golfer counts at their score through the cut. With
// "add penalties" on, each missed-cut golfer adds the league's
// missed-cut penalty, and the team bet adds the missed-deadline
// penalty.
//
// Ace bounty, settled per completed tournament: for each hole-in-one
// by a golfer on your team, every other eligible member pays you the
// bounty.
//
// Eligibility mirrors the weekly money rule: a member counts for a
// season if they joined before its first tournament's picks locked,
// and for an ace bounty if they joined before that event locked.
// ============================================================

export type CumulativeBet = 'team' | 'topTier' | 'darkHorse';
export const CUMULATIVE_BETS: CumulativeBet[] = ['team', 'topTier', 'darkHorse'];
export const BET_LABELS: Record<CumulativeBet, string> = {
  team:      'Best cumulative team',
  topTier:   'Best cumulative top tier',
  darkHorse: 'Best cumulative dark horse',
};

export interface SeasonBetConfig {
  seasonCount:      number;
  /** Bet per player, per season, or null when the bet is off. */
  amounts:          Record<CumulativeBet, number | null>;
  addPenalties:     boolean;
  missedCutPenalty: number;
  /** $ each other member pays per ace, or null when off. */
  aceBounty:        number | null;
}

type Money = string | number | null | undefined;
const money = (v: Money): number | null => (v == null ? null : Number(v));

export function seasonBetConfigFromLeague(league: {
  season_count?: number | null;
  bet_team_cumulative?: Money;
  bet_top_tier_cumulative?: Money;
  bet_dark_horse_cumulative?: Money;
  bets_add_penalties?: boolean | null;
  bet_ace_bounty?: Money;
  missed_cut_penalty?: number | null;
}): SeasonBetConfig {
  return {
    seasonCount: league.season_count ?? 1,
    amounts: {
      team:      money(league.bet_team_cumulative),
      topTier:   money(league.bet_top_tier_cumulative),
      darkHorse: money(league.bet_dark_horse_cumulative),
    },
    addPenalties:     !!league.bets_add_penalties,
    missedCutPenalty: league.missed_cut_penalty ?? 1,
    aceBounty:        money(league.bet_ace_bounty),
  };
}

export function hasSeasonBets(cfg: SeasonBetConfig): boolean {
  return CUMULATIVE_BETS.some(b => cfg.amounts[b] != null) || cfg.aceBounty != null;
}

// ── Seasons ─────────────────────────────────────────────────

/**
 * Split tournaments (sorted by start date) into `count` seasons.
 * 26 events / 4 seasons → 7, 7, 6, 6. Empty seasons are dropped when
 * there are fewer events than seasons.
 */
export function assignSeasons<T extends { start_date: string | Date }>(
  tournaments: T[],
  count: number,
): Array<{ season: number; tournaments: T[] }> {
  const sorted = [...tournaments].sort(
    (a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime(),
  );
  const n = Math.max(1, Math.min(4, Math.floor(count)));
  const base = Math.floor(sorted.length / n);
  const extra = sorted.length % n;
  const out: Array<{ season: number; tournaments: T[] }> = [];
  let i = 0;
  for (let s = 1; s <= n; s++) {
    const size = base + (s <= extra ? 1 : 0);
    if (size === 0) continue;
    out.push({ season: s, tournaments: sorted.slice(i, i + size) });
    i += size;
  }
  return out;
}

// ── Per-team contributions ──────────────────────────────────

export interface TeamGolferLine {
  slot:          number;
  status:        string;
  /** scores.fantasy_score — the event score used for weekly scoring. */
  fantasyScore:  number | null;
  /** scores.score_to_par — raw score to par (through the cut for MC). */
  scoreToPar:    number | null;
}

export interface TeamEntry {
  userId:       string;
  /** Slots 1..topTierSlots are top tier (2, or 3 on 6-man majors). */
  topTierSlots: number;
  golfers:      TeamGolferLine[];
  /** picks.penalty_strokes — the missed-deadline penalty, if any. */
  pickPenalty:  number;
}

export function golferContribution(g: TeamGolferLine, cfg: SeasonBetConfig): number {
  if (g.status === 'missed_cut') {
    return (g.scoreToPar ?? 0) + (cfg.addPenalties ? cfg.missedCutPenalty : 0);
  }
  // Dropouts count like a missed cut without the penalty: the score
  // to par up to the withdrawal.
  if (g.status === 'withdrawn' || g.status === 'disqualified') {
    return g.scoreToPar ?? 0;
  }
  return g.fantasyScore ?? g.scoreToPar ?? 0;
}

export function teamContributions(entry: TeamEntry, cfg: SeasonBetConfig): Record<CumulativeBet, number> {
  let topTier = 0, darkHorse = 0;
  for (const g of entry.golfers) {
    const c = golferContribution(g, cfg);
    if (g.slot <= entry.topTierSlots) topTier += c; else darkHorse += c;
  }
  const penalty = cfg.addPenalties ? entry.pickPenalty : 0;
  return { team: topTier + darkHorse + penalty, topTier, darkHorse };
}

// ── Season standings + settlement ───────────────────────────

export interface SeasonTournamentInput {
  lockedAt: string | Date;
  entries:  TeamEntry[];
}

export interface SeasonStandings {
  eligible: string[];
  totals:   Record<CumulativeBet, Map<string, number>>;
}

const ms = (v: string | Date) => new Date(v).getTime();

export function computeSeasonStandings(args: {
  members:     Array<{ user_id: string; joined_at: string | Date }>;
  tournaments: SeasonTournamentInput[];
  cfg:         SeasonBetConfig;
}): SeasonStandings {
  const firstLock = args.tournaments.length
    ? Math.min(...args.tournaments.map(t => ms(t.lockedAt)))
    : Infinity;
  const eligible = args.members
    .filter(m => ms(m.joined_at) <= firstLock)
    .map(m => m.user_id);
  const eligibleSet = new Set(eligible);

  const totals = {
    team:      new Map<string, number>(),
    topTier:   new Map<string, number>(),
    darkHorse: new Map<string, number>(),
  };
  for (const uid of eligible) for (const b of CUMULATIVE_BETS) totals[b].set(uid, 0);

  for (const t of args.tournaments) {
    for (const e of t.entries) {
      if (!eligibleSet.has(e.userId)) continue;
      const c = teamContributions(e, args.cfg);
      for (const b of CUMULATIVE_BETS) totals[b].set(e.userId, totals[b].get(e.userId)! + c[b]);
    }
  }
  return { eligible, totals };
}

/** Whole pot for one season bet: amount × eligible players. */
export function seasonPot(amount: number, eligibleCount: number): number {
  return amount * eligibleCount;
}

/**
 * Settle one cumulative bet: every eligible member bets `amount`; the
 * lowest total(s) split the whole pot. Returns net $ per member.
 */
export function settleCumulativeBet(
  eligible: string[],
  totals:   Map<string, number>,
  amount:   number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (eligible.length < 2 || amount <= 0) {
    for (const uid of eligible) out.set(uid, 0);
    return out;
  }
  const best = Math.min(...eligible.map(uid => totals.get(uid) ?? 0));
  const winners = eligible.filter(uid => (totals.get(uid) ?? 0) === best);
  const share = seasonPot(amount, eligible.length) / winners.length;
  const isWinner = new Set(winners);
  for (const uid of eligible) out.set(uid, (isWinner.has(uid) ? share : 0) - amount);
  return out;
}

// ── Aces ────────────────────────────────────────────────────

export interface Ace { golferId: string; round: number; hole: number; }

/** Holes played in exactly one stroke, from round_N_holes arrays. */
export function detectAces(golferId: string, holesByRound: Array<number[] | null>): Ace[] {
  const out: Ace[] = [];
  holesByRound.forEach((holes, r) => {
    (holes ?? []).forEach((strokes, h) => {
      if (strokes === 1) out.push({ golferId, round: r + 1, hole: h + 1 });
    });
  });
  return out;
}

export const aceKey = (a: Ace) => `${a.golferId}:${a.round}:${a.hole}`;

/** Apply commissioner adjustments: 'add' credits an ace, 'void' removes one. */
export function applyAceAdjustments(
  detected: Ace[],
  adjustments: Array<Ace & { action: 'add' | 'void' }>,
): Ace[] {
  const map = new Map(detected.map(a => [aceKey(a), a]));
  for (const adj of adjustments) {
    const a = { golferId: adj.golferId, round: adj.round, hole: adj.hole };
    if (adj.action === 'add') map.set(aceKey(a), a);
    else map.delete(aceKey(a));
  }
  return [...map.values()];
}

/**
 * Per-ace bounty: each owner of an acing golfer collects `bounty` from
 * every other eligible member, per ace. `acesByOwner` = number of aces
 * by golfers on each member's team.
 */
export function settleAceBounties(
  eligible:    string[],
  acesByOwner: Map<string, number>,
  bounty:      number,
): Map<string, number> {
  const out = new Map<string, number>(eligible.map(uid => [uid, 0]));
  const n = eligible.length;
  for (const [owner, count] of acesByOwner) {
    if (!out.has(owner) || count <= 0) continue;
    for (const uid of eligible) {
      out.set(uid, out.get(uid)! + (uid === owner ? bounty * (n - 1) * count : -bounty * count));
    }
  }
  return out;
}
