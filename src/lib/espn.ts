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
// Exported for unit tests (see tests/espn.test.ts).
export function normalizeScoreboardCompetitor(c: any): ESPNCompetitor | null {
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
  const rawLinescores = (c.linescores ?? [])
    .filter((ls: any) => ls?.value !== undefined || ls?.displayValue !== undefined);

  const linescores = rawLinescores.map((ls: any) => {
    const sp = ls.displayValue !== undefined
      ? parseESPNScore(ls.displayValue)
      : (ls.value as number);
    return { value: sp, displayValue: ls.displayValue ?? String(sp) };
  });

  // ── Derive thru / currentRound from the scoreboard linescores ──
  // The /pga/leaderboard endpoint returns a top-level status.thru
  // (holes completed in the current round). The /pga/scoreboard
  // fallback omits that field — but each per-round entry in
  // `c.linescores[]` carries an INNER `linescores` array with one
  // entry per hole played, plus a `period` (1..4) field. Use the
  // highest-period entry as the current round and read its inner
  // array length to recover the same number.
  //
  // Why bother: ESPN's leaderboard endpoint has been 404-ing for
  // tournaments served only via scoreboard (saw this on The Memorial,
  // 2026-06-04). Without this derivation, holes_played stays NULL
  // forever for those events and the new "Thru N" cell on the
  // leaderboard never lights up.
  let derivedThru:         number | null = null;
  let derivedCurrentRound: number | null = null;
  if (Array.isArray(c.linescores) && c.linescores.length > 0) {
    const highest = c.linescores.reduce(
      (best: any, ls: any) =>
        (best == null || (ls?.period ?? 0) > (best?.period ?? 0)) ? ls : best,
      null,
    );
    if (highest) {
      derivedCurrentRound = typeof highest.period === 'number' ? highest.period : null;
      if (Array.isArray(highest.linescores)) {
        // Defensive: cap at 18 in case ESPN ever returns a junk run-on.
        derivedThru = Math.min(highest.linescores.length, 18);
      }
    }
  }
  const fallbackStatus = c.status ?? {
    type: { name: 'active' },
    thru: derivedThru,
    currentRound: derivedCurrentRound,
  };
  // If `c.status` exists but lacks thru/currentRound (rare middle
  // shape), backfill from the derived values.
  const normalizedStatus = {
    type:         fallbackStatus.type ?? { name: 'active' },
    thru:         typeof fallbackStatus.thru === 'number'
                    ? fallbackStatus.thru
                    : derivedThru,
    currentRound: typeof fallbackStatus.currentRound === 'number'
                    ? fallbackStatus.currentRound
                    : derivedCurrentRound,
  };

  return {
    id:          String(c.id),
    displayName: name,
    shortName:   c.athlete?.shortName ?? name,
    headshot:    c.athlete?.headshot ?? c.headshot ?? undefined,
    status:      normalizedStatus,
    score:       { displayValue: rawScore, value: parseESPNScore(rawScore) },
    linescores,
    statistics:  [],
    sortOrder:   typeof c.sortOrder === 'number'
      ? c.sortOrder
      : typeof c.order === 'number' ? c.order : 0,
  };
}

// ── Upcoming-event field (pre-tournament) ────────────────────
// Pulls the field for a tournament whose start_date is in the
// future. Used by runFieldSync in src/lib/sync.ts.
//
// Why not fetchLiveLeaderboard for this:
//   /pga/scoreboard?event=X silently returns the CURRENTLY LIVE
//   event regardless of the ?event= filter. For an upcoming
//   tournament X this returns the wrong field — confirmed
//   empirically 2026-05-23 with CSC (event 401811949): the filter
//   was ignored and Byron Nelson's 147 golfers came back instead
//   of CSC's 0. Catastrophic for field-sync — we'd seed CSC with
//   the wrong roster and unlock picks against a fictional field.
//
// Date-filtered scoreboard (?dates=YYYYMMDD) returns events that
// START on that date, with `competitions[0].competitors` populated
// only once ESPN publishes the field. Multiple events on the same
// date are possible (rare on PGA Tour but not impossible), so we
// defensively filter by event id before returning.
//
// Returns an empty array when the field isn't out yet (NOT throws)
// so the caller distinguishes "field not published" from a real
// fetch error.
export async function fetchUpcomingEventField(
  espnEventId: string,
  startDate:   Date | string,
): Promise<ESPNCompetitor[]> {
  const d = typeof startDate === 'string' ? new Date(startDate) : startDate;
  const yyyymmdd = `${d.getUTCFullYear()}` +
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(d.getUTCDate()).padStart(2, '0')}`;
  const url = `${ESPN_WEB}/pga/scoreboard?dates=${yyyymmdd}`;

  const res = await fetch(url, { cache: 'no-store' } as RequestInit);
  if (!res.ok) throw new Error(`ESPN dates scoreboard failed: ${res.status}`);
  const data = await res.json();

  const event = (data.events ?? []).find(
    (e: any) => String(e.id) === String(espnEventId),
  );
  if (!event) return [];

  const rawCompetitors = event.competitions?.[0]?.competitors ?? [];
  return rawCompetitors
    .map(normalizeScoreboardCompetitor)
    .filter((c: ESPNCompetitor | null): c is ESPNCompetitor => c !== null);
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
// "f", "mdf".
//
// MDF ("made cut, did not finish") = player survived the cut but
// pulled out before the tournament ended. Their stroke total up to
// the withdrawal point is valid, and the product call is to keep
// scoring them as 'active' (their score continues to count in the
// user's foursome rather than vanishing). The explicit branch below
// pins that decision so future status additions can't accidentally
// route MDF down a different path via ordering.
export function mapESPNStatus(espnStatus: string): Score['status'] {
  const s = espnStatus.toLowerCase();
  if (s === 'mdf')                                       return 'active';
  if (s.includes('cut') || s === 'mc')                   return 'missed_cut';
  if (s.includes('wd') || s.includes('withdrew'))         return 'withdrawn';
  if (s.includes('dq'))                                  return 'disqualified';
  if (s.includes('complete') || s.includes('final') || s === 'f')
                                                         return 'complete';
  return 'active';
}

type Score = { status: 'active' | 'missed_cut' | 'withdrawn' | 'disqualified' | 'complete' };
