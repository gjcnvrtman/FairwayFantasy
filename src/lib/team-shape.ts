// ============================================================
// TEAM SHAPE — how many golfers a team has for a given tournament.
//
//   4-man (default, every regular event, every legacy league):
//     2 top tier + 2 dark horse, best 3 count.
//   6-man (majors only, when the league chose major_team_size = 6
//   at setup — migration 026):
//     3 top tier + 3 dark horse, best 4 count.
//
// Slots are 1-based: slots 1..topTier are top tier, the rest dark
// horse. Pure — no I/O.
// ============================================================

export interface TeamShape {
  size:     4 | 6;
  topTier:  number;   // slots 1..topTier are top tier
  counting: number;   // best N golfers count toward the total
}

export const TEAM_4: TeamShape = { size: 4, topTier: 2, counting: 3 };
export const TEAM_6: TeamShape = { size: 6, topTier: 3, counting: 4 };

export function teamShapeFor(
  league: { major_team_size?: number | null },
  tournament: { type?: string | null },
): TeamShape {
  return league.major_team_size === 6 && tournament.type === 'major' ? TEAM_6 : TEAM_4;
}

/** 1..size — the slot numbers for a shape. */
export function teamSlots(shape: TeamShape): number[] {
  return Array.from({ length: shape.size }, (_, i) => i + 1);
}

/** Golfer ids from a picks row, slot order, trimmed to the shape. */
export function pickGolferIds(
  pick: Partial<Record<`golfer_${1 | 2 | 3 | 4 | 5 | 6}_id`, string | null>>,
  shape: TeamShape,
): Array<string | null> {
  return teamSlots(shape).map(s => pick[`golfer_${s}_id` as `golfer_1_id`] ?? null);
}

export function isTopTierSlot(slot: number, shape: TeamShape): boolean {
  return slot <= shape.topTier;
}
