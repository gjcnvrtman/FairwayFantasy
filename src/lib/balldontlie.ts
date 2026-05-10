// ============================================================
// BALLDONTLIE PGA — OWGR rankings source.
//
// Replaces ESPN's defunct /pga/rankings endpoint (returns 500 with
// {"code":2404,"detail":"http error: not found"} since May 2026).
//
// Free tier: 5 requests/minute. We use 2 paginated requests every
// Monday for the top 200 ranked players. Well under the limit.
//
// Sign up at app.balldontlie.io to get an API key, put it in
// .env.local as BALLDONTLIE_API_KEY.
//
// IMPORTANT: balldontlie returns NO ESPN id and NO headshot URL.
// Use this source to UPDATE owgr_rank on already-existing golfers
// (those rows get their espn_id + headshot from ESPN's field /
// leaderboard endpoints).
// ============================================================

const API_BASE = 'https://api.balldontlie.io/pga/v1';

export interface BdlPlayer {
  id:           number;
  first_name:   string;
  last_name:    string;
  display_name: string;
  country:      string | null;
  country_code: string | null;
  owgr:         number | null;
  active:       boolean;
}

interface BdlListResponse {
  data: BdlPlayer[];
  meta: { next_cursor: number | null; per_page: number };
}

function getApiKey(): string {
  const key = process.env.BALLDONTLIE_API_KEY;
  if (!key || key.length < 8) {
    throw new Error(
      'BALLDONTLIE_API_KEY is missing or too short. Sign up at ' +
      'https://app.balldontlie.io and add it to .env.local.',
    );
  }
  return key;
}

/**
 * Fetch up to `topN` ranked players from balldontlie, sorted by OWGR.
 * Paginates via cursor; defaults to top 200 (more than enough — top
 * tier is 1..24, anything past 30 is academic for our rules).
 *
 * Filter `active=true` so we don't pull retired players who still
 * have stale ranks attached.
 */
export async function fetchWorldRankings({ topN = 200 } = {}): Promise<BdlPlayer[]> {
  const apiKey  = getApiKey();
  const perPage = Math.min(100, topN);
  let cursor: number | null = null;
  const all: BdlPlayer[] = [];

  for (let page = 0; page < 10; page++) {
    const url = new URL(`${API_BASE}/players`);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('active', 'true');
    if (cursor !== null) url.searchParams.set('cursor', String(cursor));

    const res = await fetch(url.toString(), {
      headers: { Authorization: apiKey },
      cache:   'no-store',
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `balldontlie /players: HTTP ${res.status} - ${body.slice(0, 200)}`,
      );
    }

    const json = await res.json() as BdlListResponse;
    all.push(...json.data);

    cursor = json.meta.next_cursor;
    if (cursor === null) break;
    if (all.length >= topN * 2) break;     // guard — never page forever
  }

  // Filter to ranked only, sort by rank, cap at topN. Players with
  // null owgr are excluded — they're irrelevant for our pick rules
  // (their `is_dark_horse` would be NULL anyway, treated as DH).
  return all
    .filter(p => typeof p.owgr === 'number')
    .sort((a, b) => (a.owgr ?? 9999) - (b.owgr ?? 9999))
    .slice(0, topN);
}
