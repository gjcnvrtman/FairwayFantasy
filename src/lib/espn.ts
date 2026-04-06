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
export async function fetchLiveLeaderboard(espnEventId: string): Promise<{
  competitors: ESPNCompetitor[];
  cutScore: number | null;
  status: string;
  currentRound: number;
}> {
  const res = await fetch(
    `${ESPN_WEB}/pga/leaderboard?event=${espnEventId}`,
    { cache: 'no-store' } as RequestInit // always fresh during tournament
  );

  if (!res.ok) throw new Error(`ESPN leaderboard fetch failed for event ${espnEventId}`);
  const data: ESPNLeaderboard = await res.json();

  const competition = data.events?.[0]?.competitions?.[0];
  if (!competition) return { competitors: [], cutScore: null, status: 'unknown', currentRound: 0 };

  // Parse cut score from ESPN's situation object
  const cutRaw = competition.situation?.cutLine?.value ?? null;

  return {
    competitors:  competition.competitors ?? [],
    cutScore:     cutRaw !== null ? Math.round(cutRaw) : null,
    status:       competition.status.type.name,
    currentRound: competition.status.period,
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
export function mapESPNStatus(espnStatus: string): Score['status'] {
  const s = espnStatus.toLowerCase();
  if (s.includes('cut') || s === 'mc')        return 'missed_cut';
  if (s.includes('wd') || s.includes('withdrew')) return 'withdrawn';
  if (s.includes('dq'))                       return 'disqualified';
  if (s.includes('complete') || s === 'f')    return 'complete';
  return 'active';
}

type Score = { status: 'active' | 'missed_cut' | 'withdrawn' | 'disqualified' | 'complete' };
