// ============================================================
// TEAM SCORECARD — pure builders for /league/[slug]/team/[userId].
//
// Turns a member's picked golfers + their per-hole stroke arrays into
// scorecard rows for one round: 18 stroke cells, per-hole result vs
// par, OUT / IN / TOT, round to-par, tournament to-par. No I/O.
// ============================================================

export const HOLES = 18;

export interface TeamGolferInput {
  slot:             number;            // 1-based pick slot
  name:             string;
  /** Original golfer's name when this slot was replaced after a WD. */
  replacedFromName?: string | null;
  status:           string;            // scores.status
  /** round_1_holes..round_4_holes — strokes per hole, length 0..18. */
  holesByRound:     Array<number[] | null>;
  /** scores.score_to_par — tournament total to par. */
  tournamentToPar:  number | null;
  /** fantasy_results.golfer_N_score — this league's scored value. */
  fantasyScore:     number | null;
  /** Slot is one of the golfers counting toward the team total. */
  counting:         boolean;
}

export type HoleResult = 'eagle' | 'birdie' | 'par' | 'bogey' | 'double' | null;

export interface ScorecardRow {
  slot:             number;
  tierLabel:        'Top tier' | 'Dark horse';
  name:             string;
  replacedFromName: string | null;
  status:           string;
  strokes:          Array<number | null>;   // always length 18
  results:          HoleResult[];           // vs par; null when unplayed or par unknown
  holesPlayed:      number;
  out:              number | null;          // only when all front 9 played
  in:               number | null;          // only when all back 9 played
  total:            number | null;          // only when all 18 played
  /** Strokes minus par over the holes played; null if any played hole lacks par. */
  roundToPar:       number | null;
  tournamentToPar:  number | null;
  fantasyScore:     number | null;
  counting:         boolean;
}

function holeResult(strokes: number | null, par: number | null | undefined): HoleResult {
  if (strokes == null || par == null) return null;
  const d = strokes - par;
  if (d <= -2) return 'eagle';
  if (d === -1) return 'birdie';
  if (d === 0)  return 'par';
  if (d === 1)  return 'bogey';
  return 'double';
}

function sumIfComplete(arr: Array<number | null>, start: number, end: number): number | null {
  let t = 0;
  for (let i = start; i < end; i++) {
    const v = arr[i];
    if (v == null) return null;
    t += v;
  }
  return t;
}

export function buildScorecardRows(args: {
  golfers:       TeamGolferInput[];
  round:         number;                         // 1..4
  parByHole:     Array<number | null> | null;
  /** Slots 1..topTierSlots are top tier. 2 today; 3 for 6-man majors. */
  topTierSlots?: number;
}): ScorecardRow[] {
  const { golfers, round, parByHole } = args;
  const topTierSlots = args.topTierSlots ?? 2;

  return [...golfers]
    .sort((a, b) => a.slot - b.slot)
    .map(g => {
      const raw = g.holesByRound[round - 1] ?? [];
      const strokes: Array<number | null> = Array.from({ length: HOLES }, (_, i) => {
        const v = raw[i];
        return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
      });
      const results = strokes.map((s, i) => holeResult(s, parByHole?.[i]));

      let played = 0, strokesSum = 0, parSum = 0, parKnown = true;
      strokes.forEach((s, i) => {
        if (s == null) return;
        played += 1;
        strokesSum += s;
        const p = parByHole?.[i];
        if (p == null) parKnown = false; else parSum += p;
      });

      return {
        slot:             g.slot,
        tierLabel:        g.slot <= topTierSlots ? 'Top tier' : 'Dark horse',
        name:             g.name,
        replacedFromName: g.replacedFromName ?? null,
        status:           g.status,
        strokes,
        results,
        holesPlayed:      played,
        out:              sumIfComplete(strokes, 0, 9),
        in:               sumIfComplete(strokes, 9, 18),
        total:            sumIfComplete(strokes, 0, 18),
        roundToPar:       played > 0 && parKnown ? strokesSum - parSum : null,
        tournamentToPar:  g.tournamentToPar,
        fantasyScore:     g.fantasyScore,
        counting:         g.counting,
      };
    });
}

/**
 * Round to open by default: the latest round where any of the team's
 * golfers has hole data. Round 1 when nothing has been played.
 */
export function defaultScorecardRound(golfers: Pick<TeamGolferInput, 'holesByRound'>[]): number {
  for (let r = 4; r >= 1; r--) {
    if (golfers.some(g => (g.holesByRound[r - 1]?.length ?? 0) > 0)) return r;
  }
  return 1;
}

/** Parse a ?round= value; falls back when missing or out of range. */
export function parseRoundParam(v: string | string[] | undefined, fallback: number): number {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : fallback;
}

/** "E", "+2", "−3" (true minus sign, matching the leaderboard). */
export function formatToPar(n: number | null): string {
  if (n == null) return '—';
  if (n === 0) return 'E';
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`;
}
