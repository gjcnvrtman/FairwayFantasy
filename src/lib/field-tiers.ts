// Per-tournament tier classifier. The tier of a golfer for a given
// pick is no longer the global `golfers.is_dark_horse` column —
// instead it's "where do they rank within THIS tournament's field?"
//
// Rule (decided 2026-06-13):
//   - Top tier  = up to TOP_TIER_SIZE highest OWGR-ranked golfers IN
//                 this tournament's field. Unranked golfers never
//                 count toward top tier — even if the field has fewer
//                 than TOP_TIER_SIZE ranked players, the remaining
//                 top-tier slots stay empty rather than getting filled
//                 with unranked players. This keeps "top tier" actually
//                 meaning "real-deal big names" instead of "literally
//                 any of the 24 best-sorted slots".
//   - Dark horse = every other golfer in the field (lower-ranked +
//                  unranked).
//
// Stable tiebreak by golfer id when ranks tie (shouldn't happen since
// OWGR is a global integer, but defensive).
//
// Used by:
//   - /api/picks/setup route (returns the Set as an array)
//   - /api/picks POST + PUT validation
//   - /api/players?tier= when a tournament_id is supplied
//   - sweepMissedPicks → buildAutoLineup
//
// We retain the global `golfers.is_dark_horse` column as a static
// hint for non-tournament contexts; it just isn't authoritative for
// pick eligibility anymore.

export const TOP_TIER_SIZE = 24;

export function computeTopTierIds(
  field: Array<{ id: string; owgr_rank: number | null }>,
  size: number = TOP_TIER_SIZE,
): Set<string> {
  const ranked = field
    .filter(g => g.owgr_rank != null)
    .sort((a, b) => {
      const cmp = (a.owgr_rank as number) - (b.owgr_rank as number);
      return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
    });
  return new Set(ranked.slice(0, size).map(g => g.id));
}
