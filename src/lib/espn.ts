// ============================================================
// ESPN API CLIENT
// Unofficial public endpoints — no API key required
// ============================================================

import type { ESPNLeaderboard, ESPNCompetitor } from '@/types';

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/golf';
const ESPN_WEB  = 'https://site.web.api.espn.com/apis/site/v2/sports/golf';

// ── Schedule ────────────────────────────────────────────────
export async function fetchPGASchedule() {
  const res = await fetch(`${ESPN_BASE}/pga/scoreboard`, {
    cache: "force-cache",
  });
  if (!res.ok) throw new Error('ESPN schedule fetch failed');
  const data = await res.json();

  // Calendar lives in leagues[0].calendar
  const calendar = data?.leagues?.[0]?.calendar ?? [];

  return calendar.map((event: any) => ({
    espn_event_id: event.id,
    name:          event.label,
    start_date:    event.startDate,
    end_date:      event.endDate,
    // Flag the 4 Majors by name
    type: isMajor(event.label) ? 'major' : 'regular',
    season: new Date(event.startDate).getFullYear(),
  }));
}

function isMajor(name: string): boolean {
  const majors = ['Masters', 'PGA Championship', 'U.S. Open', 'The Open Championship'];
  return majors.some(m => name.includes(m));
}

// ── Live Leaderboard ─────────────────────────────────────────
// As of May 2026 ESPN's /pga/leaderboard endpoint returns 404 for some
// events that ARE live (confirmed against PGA Championship event
// 401811947 on the morning of Round 1). The /pga/scoreboard endpoint
// returns 200 with the same event but a DIFFERENT competitor shape:
//
//   leaderboard:  c.displayName, c.score.displayValue, c.linescores[i].value (score-to-par)
//   scoreboard:   c.athlete.displayName, c.score (raw string), c.linescores[i].displayValue
//
// Plus scoreboard doesn't provide per-golfer status (missed_cut / WD /
// DQ) — that field is absent. We default normalized competitors from
// scoreboard to status='active'. Fine for Round 1-2 active play; if
// the leaderboard endpoint is still 404 on cut day, status detection
// will need a different signal.
export async function fetchLiveLeaderboard(espnEventId: string): Promise<{
  competitors: ESPNCompetitor[];
  cutScore: number | null;
  status: string;
  currentRound: number;
}> {
  const candidates: Array<{ url: string; shape: 'leaderboard' | 'scoreboard' }> = [
    { url: `${ESPN_WEB}/pga/leaderboard?event=${espnEventId}`, shape: 'leaderboard' },
    { url: `${ESPN_BASE}/pga/scoreboard?event=${espnEventId}`, shape: 'scoreboard' },
  ];

  let data: any = null;
  let usedShape: 'leaderboard' | 'scoreboard' = 'leaderboard';
  for (const { url, shape } of candidates) {
    const res = await fetch(url, { cache: 'no-store' } as RequestInit);
    if (res.ok) {
      data = await res.json();
      usedShape = shape;
      break;
    }
  }
  if (!data) {
    throw new Error(`ESPN leaderboard+scoreboard both failed for event ${espnEventId}`);
  }

  const competition = data.events?.[0]?.competitions?.[0];
  if (!competition) return { competitors: [], cutScore: null, status: 'unknown', currentRound: 0 };

  const rawCompetitors = competition.competitors ?? [];
  const competitors: ESPNCompetitor[] = usedShape === 'scoreboard'
    ? rawCompetitors
        .map(normalizeScoreboardCompetitor)
        .filter((c: ESPNCompetitor | null): c is ESPNCompetitor => c !== null)
    : rawCompetitors;

  const cutRaw = competition.situation?.cutLine?.value ?? null;

  return {
    competitors,
    cutScore:     cutRaw !== null ? Math.round(cutRaw) : null,
    status:       competition.status?.type?.name ?? 'unknown',
    currentRound: competition.status?.period ?? 0,
  };
}

// Convert a /pga/scoreboard competitor into an ESPNCompetitor so the
// rest of the pipeline (`sync.ts`) doesn't have to branch on shape.
// Returns null if the row lacks a name we can match against `golfers`.
function normalizeScoreboardCompetitor(c: any): ESPNCompetitor | null {
  const name = c?.athlete?.displayName ?? c?.athlete?.fullName ?? c?.displayName;
  if (!name) return null;

  // Scoreboard's `c.score` is the raw display string ("-3"); leaderboard
  // wraps it as `{displayValue, value}`. Unify to the wrapped shape.
  const rawScore = typeof c.score === 'string'
    ? c.score
    : (c.score?.displayValue ?? 'E');

  // Per-round line scores: scoreboard puts the round's score-to-par in
  // `displayValue` ("-3") and the total strokes in `value` (67).
  // Historical leaderboard shape used `value` for score-to-par directly.
  // We normalize so `value` carries the integer score-to-par, matching
  // what `sync.ts` writes into the `scores.round_N` INT columns. Drop
  // entries that have neither field (un-played future rounds) so they
  // store as NULL via `rounds[i] ?? null` downstream.
  const linescores = (c.linescores ?? [])
    .filter((ls: any) => ls?.value !== undefined || ls?.displayValue !== undefined)
    .map((ls: any) => {
      const sp = ls.displayValue !== undefined
        ? parseESPNScore(ls.displayValue)
        : (ls.value as number);
      return { value: sp, displayValue: ls.displayValue ?? String(sp) };
    });

  return {
    id:          String(c.id),
    displayName: name,
    shortName:   c.athlete?.shortName ?? name,
    headshot:    c.athlete?.headshot ?? c.headshot ?? undefined,
    status:      c.status ?? { type: { name: 'active' }, thru: 0, currentRound: 0 },
    score:       { displayValue: rawScore, value: parseESPNScore(rawScore) },
    linescores,
    statistics:  [],
    sortOrder:   typeof c.sortOrder === 'number'
      ? c.sortOrder
      : typeof c.order === 'number' ? c.order : 0,
  };
}

// ── All Players in Field ─────────────────────────────────────
export async function fetchEventField(espnEventId: string): Promise<Array<{
  espn_id: string;
  name: string;
  headshot_url: string | null;
  status: string;
  tee_time?: string;
}>> {
  const res = await fetch(
    `${ESPN_WEB}/pga/leaderboard?event=${espnEventId}`,
    { cache: 'force-cache' } as RequestInit
  );
  if (!res.ok) return [];
  const data: ESPNLeaderboard = await res.json();

  const competitors = data.events?.[0]?.competitions?.[0]?.competitors ?? [];

  return competitors.map((c: ESPNCompetitor) => ({
    espn_id:     c.id,
    name:        c.displayName,
    headshot_url: c.headshot?.href ?? null,
    status:      c.status?.type?.name ?? 'active',
  }));
}

// ── Parse score string to integer ───────────────────────────
// ESPN returns "-4", "E", "+2" — convert to integer strokes to par
export function parseESPNScore(displayValue: string): number {
  if (!displayValue || displayValue === '-') return 0;
  if (displayValue === 'E') return 0;
  const n = parseInt(displayValue, 10);
  return isNaN(n) ? 0 : n;
}

// ── Map ESPN status to our status ───────────────────────────
// ESPN status strings observed: "STATUS_ACTIVE", "STATUS_FINAL",
// "STATUS_SCHEDULED", and shorter forms like "cut", "wd", "dq", "mc",
// "f". See bug #5.10 for unmapped statuses (e.g. MDF "made cut, did
// not finish") that currently fall through to 'active'.
export function mapESPNStatus(espnStatus: string): Score['status'] {
  const s = espnStatus.toLowerCase();
  if (s.includes('cut') || s === 'mc')                   return 'missed_cut';
  if (s.includes('wd') || s.includes('withdrew'))         return 'withdrawn';
  if (s.includes('dq'))                                  return 'disqualified';
  if (s.includes('complete') || s.includes('final') || s === 'f')
                                                         return 'complete';
  return 'active';
}

type Score = { status: 'active' | 'missed_cut' | 'withdrawn' | 'disqualified' | 'complete' };
