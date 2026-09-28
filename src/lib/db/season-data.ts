// ============================================================
// SEASON BETS — data loader (migration 027).
//
// Pulls one league's schedule, members, picks, scores and ace
// adjustments, then runs the pure engine in src/lib/season-bets.ts.
// Used by the Seasons page and by every money total (league home,
// stats, history, league-delete audit) so side bets settle into the
// same $ figures everywhere.
//
// Settlement: a season's cumulative bets pay out once every
// tournament in it is complete (each player bets the amount, the
// winner takes the pot); an ace bounty pays out once its tournament
// is complete. In-progress standings are shown but move no money.
// ============================================================

import { db } from './index';
import { loadReplacements } from './queries';
import { effectivePickDeadline } from '@/lib/pick-deadline';
import { teamShapeFor, teamSlots, pickGolferIds } from '@/lib/team-shape';
import {
  seasonBetConfigFromLeague, hasSeasonBets, assignSeasons, computeSeasonStandings,
  settleCumulativeBet, seasonPot, detectAces, applyAceAdjustments, settleAceBounties, aceKey,
  CUMULATIVE_BETS, type CumulativeBet, type SeasonBetConfig, type TeamEntry,
  type SeasonTournamentInput, type Ace,
} from '@/lib/season-bets';

export interface SeasonBetStanding { userId: string; total: number; rank: number; }

export interface SeasonView {
  season:      number;
  tournaments: Array<{ id: string; name: string; status: string; start_date: string }>;
  complete:    boolean;
  eligible:    string[];
  bets: Array<{
    bet:       CumulativeBet;
    /** Bet per player. */
    amount:    number;
    /** Whole pot = amount × eligible players. */
    pot:       number;
    standings: SeasonBetStanding[];
    /** Net $ per member — only once the season is complete. */
    deltas:    Map<string, number> | null;
  }>;
}

export interface AceView {
  tournamentId:   string;
  tournamentName: string;
  golferId:       string;
  golferName:     string;
  round:          number;
  hole:           number;
  source:         'auto' | 'manual';
  owners:         string[];
  settled:        boolean;
}

export interface SeasonBetsData {
  cfg:        SeasonBetConfig;
  seasons:    SeasonView[];
  aces:       AceView[];
  /** Voided auto-detected aces, so the admin can restore them. */
  voidedAces: Array<{ tournamentId: string; golferId: string; round: number; hole: number }>;
  /** Settled side-bet net $ per member (seasons + ace bounties). */
  sideTotals: Map<string, number>;
}

type LeagueLike = Parameters<typeof seasonBetConfigFromLeague>[0] & {
  id: string;
  major_team_size?: number | null;
};

function rankAscending(totals: Map<string, number>, eligible: string[]): SeasonBetStanding[] {
  const rows = eligible
    .map(userId => ({ userId, total: totals.get(userId) ?? 0 }))
    .sort((a, b) => a.total - b.total);
  let rank = 1;
  return rows.map((r, i) => {
    if (i > 0 && r.total !== rows[i - 1].total) rank = i + 1;
    return { ...r, rank };
  });
}

/** null when the league has no season bets (every legacy league). */
export async function loadSeasonBets(league: LeagueLike): Promise<SeasonBetsData | null> {
  const cfg = seasonBetConfigFromLeague(league);
  if (!hasSeasonBets(cfg)) return null;

  const [schedule, members, adjustments] = await Promise.all([
    db.selectFrom('tournaments')
      .innerJoin('league_tournaments', 'league_tournaments.tournament_id', 'tournaments.id')
      .select(['tournaments.id', 'tournaments.name', 'tournaments.type', 'tournaments.status',
               'tournaments.start_date', 'tournaments.pick_deadline',
               'tournaments.pick_deadline_override'])
      .where('league_tournaments.league_id', '=', league.id)
      .where('tournaments.hidden', '=', false)
      .execute(),
    db.selectFrom('league_members')
      .select(['user_id', 'joined_at'])
      .where('league_id', '=', league.id)
      .execute(),
    db.selectFrom('league_ace_adjustments')
      .select(['tournament_id', 'golfer_id', 'round_num', 'hole_num', 'action'])
      .where('league_id', '=', league.id)
      .execute(),
  ]);

  const started = schedule.filter(t => t.status !== 'upcoming');
  const startedIds = started.map(t => t.id);

  const [picks, scores] = startedIds.length === 0 ? [[], []] : await Promise.all([
    db.selectFrom('picks')
      .select(['id', 'tournament_id', 'user_id', 'penalty_strokes',
               'golfer_1_id', 'golfer_2_id', 'golfer_3_id',
               'golfer_4_id', 'golfer_5_id', 'golfer_6_id'])
      .where('league_id', '=', league.id)
      .where('tournament_id', 'in', startedIds)
      .execute(),
    db.selectFrom('scores')
      .innerJoin('golfers', 'golfers.id', 'scores.golfer_id')
      .select(['scores.tournament_id', 'scores.golfer_id', 'golfers.name as golfer_name',
               'scores.status', 'scores.fantasy_score', 'scores.score_to_par',
               'scores.round_1_holes', 'scores.round_2_holes',
               'scores.round_3_holes', 'scores.round_4_holes'])
      .where('scores.tournament_id', 'in', startedIds)
      .execute(),
  ]);

  // Each player's own WD swaps (migration 028).
  const swaps = await loadReplacements(picks.map(p => p.id));
  const scoreKey = (t: string, g: string) => `${t}:${g}`;
  const scoreBy = new Map(scores.map(s => [scoreKey(s.tournament_id, s.golfer_id), s]));
  const lockedAt = (t: typeof schedule[number]) =>
    effectivePickDeadline(t) ?? new Date(t.start_date);

  // Per started tournament: team entries + effective golfer ownership.
  const entriesBy = new Map<string, TeamEntry[]>();
  const ownersBy  = new Map<string, Map<string, string[]>>();   // tid → golferId → owners
  for (const t of started) {
    const shape = teamShapeFor(league, t);
    const entries: TeamEntry[] = [];
    const owners = new Map<string, string[]>();
    for (const p of picks.filter(p => p.tournament_id === t.id)) {
      const ids = pickGolferIds(p, shape);
      const golfers = teamSlots(shape).flatMap((slot, i) => {
        const id = ids[i];
        if (!id) return [];
        // This player's own WD swap for the slot counts (same rule as
        // computeLeagueResults).
        const effId = swaps.get(p.id)?.[slot] ?? id;
        const eff = scoreBy.get(scoreKey(t.id, effId));
        owners.set(effId, [...(owners.get(effId) ?? []), p.user_id]);
        return [{
          slot,
          status:       eff?.status ?? 'active',
          fantasyScore: eff?.fantasy_score ?? null,
          scoreToPar:   eff?.score_to_par ?? null,
        }];
      });
      entries.push({
        userId: p.user_id, topTierSlots: shape.topTier, golfers,
        pickPenalty: p.penalty_strokes ?? 0,
      });
    }
    entriesBy.set(t.id, entries);
    ownersBy.set(t.id, owners);
  }

  const sideTotals = new Map<string, number>(members.map(m => [m.user_id, 0]));
  const addDeltas = (d: Map<string, number>) => {
    for (const [uid, v] of d) sideTotals.set(uid, (sideTotals.get(uid) ?? 0) + v);
  };

  // ── Seasons ──
  const seasons: SeasonView[] = [];
  for (const { season, tournaments } of assignSeasons(schedule, cfg.seasonCount)) {
    const inputs: SeasonTournamentInput[] = tournaments
      .filter(t => t.status !== 'upcoming')
      .map(t => ({ lockedAt: lockedAt(t), entries: entriesBy.get(t.id) ?? [] }));
    // Eligibility is anchored on the season's first tournament even
    // before it has started.
    const firstLock = tournaments.length ? lockedAt(tournaments[0]) : new Date();
    const standings = computeSeasonStandings({
      members,
      tournaments: inputs.length ? inputs : [{ lockedAt: firstLock, entries: [] }],
      cfg,
    });
    const complete = tournaments.length > 0 && tournaments.every(t => t.status === 'complete');

    const bets = CUMULATIVE_BETS.flatMap(bet => {
      const amount = cfg.amounts[bet];
      if (amount == null) return [];
      const deltas = complete ? settleCumulativeBet(standings.eligible, standings.totals[bet], amount) : null;
      if (deltas) addDeltas(deltas);
      return [{
        bet, amount, pot: seasonPot(amount, standings.eligible.length),
        standings: rankAscending(standings.totals[bet], standings.eligible), deltas,
      }];
    });

    seasons.push({
      season,
      tournaments: tournaments.map(t => ({
        id: t.id, name: t.name, status: t.status,
        start_date: new Date(t.start_date).toISOString(),
      })),
      complete,
      eligible: standings.eligible,
      bets,
    });
  }

  // ── Aces ──
  const aces: AceView[] = [];
  const voidedAces: SeasonBetsData['voidedAces'] = [];
  if (cfg.aceBounty != null) {
    for (const t of started) {
      const owners = ownersBy.get(t.id) ?? new Map<string, string[]>();
      const detected: Ace[] = [...owners.keys()].flatMap(gid => {
        const s = scoreBy.get(scoreKey(t.id, gid));
        return s ? detectAces(gid, [s.round_1_holes, s.round_2_holes, s.round_3_holes, s.round_4_holes]) : [];
      });
      const adj = adjustments
        .filter(a => a.tournament_id === t.id)
        .map(a => ({ golferId: a.golfer_id, round: a.round_num, hole: a.hole_num, action: a.action }));
      const detectedKeys = new Set(detected.map(aceKey));
      const final = applyAceAdjustments(detected, adj);
      for (const a of adj) {
        if (a.action === 'void' && detectedKeys.has(aceKey(a))) {
          voidedAces.push({ tournamentId: t.id, golferId: a.golferId, round: a.round, hole: a.hole });
        }
      }

      const settled = t.status === 'complete';
      const acesByOwner = new Map<string, number>();
      for (const a of final) {
        const aceOwners = owners.get(a.golferId) ?? [];
        for (const o of aceOwners) acesByOwner.set(o, (acesByOwner.get(o) ?? 0) + 1);
        aces.push({
          tournamentId: t.id, tournamentName: t.name,
          golferId: a.golferId,
          golferName: scoreBy.get(scoreKey(t.id, a.golferId))?.golfer_name ?? 'Unknown golfer',
          round: a.round, hole: a.hole,
          source: detectedKeys.has(aceKey(a)) ? 'auto' : 'manual',
          owners: aceOwners, settled,
        });
      }
      if (settled && acesByOwner.size > 0) {
        const lock = lockedAt(t).getTime();
        const eligible = members
          .filter(m => new Date(m.joined_at).getTime() <= lock)
          .map(m => m.user_id);
        addDeltas(settleAceBounties(eligible, acesByOwner, cfg.aceBounty));
      }
    }
  }

  return { cfg, seasons, aces, voidedAces, sideTotals };
}

/** Add settled side-bet $ onto weekly money totals (same member order). */
export function withSideBets(
  totals: Array<{ user_id: string; amount: number }>,
  data:   SeasonBetsData | null,
): Array<{ user_id: string; amount: number }> {
  if (!data) return totals;
  return totals.map(t => ({ ...t, amount: t.amount + (data.sideTotals.get(t.user_id) ?? 0) }));
}
