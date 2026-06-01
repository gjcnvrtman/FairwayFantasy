// Helpers for the commissioner-driven field upload (ESPN-late-publish
// fallback shipped 2026-05-30).
//
// When ESPN doesn't publish the tournament field by the pick deadline,
// runFieldSync() leaves tournaments.field_published_at = NULL and
// picks stay hard-blocked. A commissioner can paste names from the
// tournament site's player list into the admin UI; the helpers below
// normalize the input, dedupe, and match each line to a row in our
// `golfers` table. Unmatched names are reported back so the
// commissioner can correct typos or add missing golfers manually.

/**
 * Reduce a golfer name to a canonical comparison key:
 *   - lowercase
 *   - strip accents / diacritics
 *   - drop everything except letters / digits / spaces
 *   - collapse whitespace to single spaces and trim
 *
 * Two reasonable spellings of the same golfer should reduce to the
 * same key. Examples:
 *   "Tom Kim"               → "tom kim"
 *   "  TOM  KIM  "          → "tom kim"
 *   "Tom Kim Joohyung"      → "tom kim joohyung"
 *   "Joaquín Niemann"       → "joaquin niemann"
 *   "Sungjae Im, *"         → "sungjae im"
 */
export function normalizeGolferName(raw: string): string {
  return raw
    .normalize('NFKD')                  // decompose accents
    .replace(/[̀-ͯ]/g, '')    // drop combining marks
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')       // commas, asterisks, dashes → space
    .replace(/\s+/g, ' ')               // collapse whitespace
    .trim();
}

/**
 * Parse a free-text upload — newline-separated names, optional comma-
 * separated extra fields per line. Examples accepted:
 *   "Tom Kim"
 *   "Tom Kim, 32"          (extra columns ignored)
 *   "Tom Kim\nScottie Scheffler\nJoaquín Niemann"
 *
 * Returns the deduplicated list of normalized name keys + the
 * corresponding "original" forms (first occurrence). Blank lines
 * skipped.
 */
export function parseUploadedNames(text: string): {
  uniqueOriginals: string[];
  uniqueKeys:      string[];
} {
  const seen = new Set<string>();
  const originals: string[] = [];
  const keys: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    // Take the first comma-separated cell so CSV exports work too.
    const cell  = rawLine.split(',')[0] ?? '';
    const key   = normalizeGolferName(cell);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
    originals.push(cell.trim());
  }
  return { uniqueOriginals: originals, uniqueKeys: keys };
}

/**
 * Match a list of name keys against an iterable of golfers from the
 * DB. Each golfer is matched by canonical-name equality. Names that
 * don't resolve to any golfer come back in `unmatched`.
 *
 * Multiple input names mapping to the same golfer ID resolve to a
 * single entry in `matched` (the dedupe in parseUploadedNames also
 * helps, but defensive).
 */
export function matchNamesToGolfers(args: {
  uniqueOriginals: string[];
  uniqueKeys:      string[];
  golfers:         Array<{ id: string; espn_id: string; name: string }>;
}): {
  matched:   Array<{ originalName: string; golferId: string; espnId: string }>;
  unmatched: string[];
} {
  const { uniqueOriginals, uniqueKeys, golfers } = args;
  // Build the canonical-key → {id, espn_id} index once.
  const keyToGolfer = new Map<string, { id: string; espn_id: string }>();
  for (const g of golfers) {
    keyToGolfer.set(normalizeGolferName(g.name), { id: g.id, espn_id: g.espn_id });
  }
  const matched: Array<{ originalName: string; golferId: string; espnId: string }> = [];
  const unmatched: string[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < uniqueKeys.length; i++) {
    const g = keyToGolfer.get(uniqueKeys[i]);
    if (g !== undefined && !seenIds.has(g.id)) {
      matched.push({
        originalName: uniqueOriginals[i],
        golferId:     g.id,
        espnId:       g.espn_id,
      });
      seenIds.add(g.id);
    } else if (g === undefined) {
      unmatched.push(uniqueOriginals[i]);
    }
    // (g defined but already seen → silently skip; same golfer twice.)
  }
  return { matched, unmatched };
}
