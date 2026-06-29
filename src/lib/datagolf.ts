// ============================================================
// Datagolf API client — General Use (free tier) endpoints.
//
// Wraps the three endpoints we need for the course-fit prediction
// system:
//   1. get-player-list           — canonical player roster + dg_id
//   2. field-updates             — current week's tournament field
//   3. preds/pre-tournament      — Datagolf's win / top-N / cut probs
//
// Reads DATAGOLF_API_KEY from process.env. Each call throws on
// HTTP error so callers can wrap with try/catch + partial-success
// reporting (same pattern as src/lib/rankings.ts).
//
// Endpoint reference (verify on first run with your General-tier key):
//   https://feeds.datagolf.com/get-player-list
//   https://feeds.datagolf.com/field-updates
//   https://feeds.datagolf.com/preds/pre-tournament
//
// Datagolf returns percentages in [0..100] when odds_format=percent.
// We normalize to [0..1] before returning so DB CHECK constraints
// match.
// ============================================================

const BASE = 'https://feeds.datagolf.com';

function key(): string {
  const k = process.env.DATAGOLF_API_KEY;
  if (!k) throw new Error('DATAGOLF_API_KEY not set');
  return k;
}

async function fetchJson<T>(path: string, query: Record<string, string>): Promise<T> {
  const params = new URLSearchParams({
    file_format: 'json',
    key: key(),
    ...query,
  });
  const url = `${BASE}${path}?${params.toString()}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    const body = await res.text().catch(() => '<no body>');
    throw new Error(`Datagolf ${path} → HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  // Datagolf occasionally returns the error envelope as 200 with
  // {message: "..."} — sniff that pattern.
  const json = await res.json();
  if (json && typeof json === 'object' && 'message' in json && Object.keys(json).length <= 2) {
    throw new Error(`Datagolf ${path} returned error envelope: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json as T;
}

// ── Endpoint: get-player-list ──────────────────────────────────
// Returns the global Datagolf player roster.
export interface DGPlayer {
  dg_id: number;
  player_name: string;       // "Scheffler, Scottie" — note last-first format
  country: string | null;
  amateur: 0 | 1;
}

export async function getPlayerList(): Promise<DGPlayer[]> {
  const raw = await fetchJson<unknown>('/get-player-list', {});
  if (!Array.isArray(raw)) {
    throw new Error('Datagolf get-player-list: expected an array, got ' + typeof raw);
  }
  return raw as DGPlayer[];
}

// ── Endpoint: field-updates ────────────────────────────────────
// Returns the current week's tournament field with WD/MC flags.
export interface DGFieldEntry {
  dg_id: number;
  player_name: string;
  am: 0 | 1;
  country: string | null;
  // Datagolf may include odds + projection columns here too; we only
  // type the identity fields. Full row is in raw_json on the consumer.
  [key: string]: unknown;
}
export interface DGFieldResponse {
  event_name: string;
  current_round: number;
  field: DGFieldEntry[];
}

export async function getFieldUpdates(tour: 'pga' | 'euro' | 'kft' = 'pga'): Promise<DGFieldResponse> {
  const json = await fetchJson<unknown>('/field-updates', { tour });
  if (!json || typeof json !== 'object' || !Array.isArray((json as { field?: unknown }).field)) {
    throw new Error('Datagolf field-updates: missing field array');
  }
  return json as DGFieldResponse;
}

// ── Endpoint: preds/pre-tournament ─────────────────────────────
// Returns per-golfer probabilities for the upcoming event.
//
// Datagolf has two model variants: "baseline" (no course history)
// and "baseline_history_fit" (with course history). We pull both
// when available; the predictor picks baseline_history_fit when
// course history is enabled, baseline otherwise.
export interface DGPreTournamentRow {
  dg_id: number;
  player_name: string;
  // Probabilities are 0..100 when odds_format=percent.
  win: number | null;
  top_5: number | null;
  top_10: number | null;
  top_20: number | null;
  make_cut: number | null;
  // Some endpoint variants include this:
  expected_finish?: number | null;
  [key: string]: unknown;
}
export interface DGPreTournamentResponse {
  event_name: string;
  last_updated: string;       // ISO timestamp from Datagolf
  baseline?: DGPreTournamentRow[];
  baseline_history_fit?: DGPreTournamentRow[];
}

export async function getPreTournamentPredictions(
  tour: 'pga' | 'euro' | 'kft' = 'pga',
): Promise<DGPreTournamentResponse> {
  // `add_position` is NOT sent — Datagolf rejects the string "no"
  // with a 400 ("please only enter valid finish positions") on the
  // General tier; the param expects a numeric finish-position cutoff
  // (1..50) to opt INTO an extra top-N column. Omitting it gives us
  // the default win / top-5 / top-10 / top-20 / make_cut shape which
  // is exactly what DGPreTournamentRow already types.
  const json = await fetchJson<unknown>('/preds/pre-tournament', {
    tour,
    odds_format: 'percent',
  });
  if (!json || typeof json !== 'object') {
    throw new Error('Datagolf preds/pre-tournament: malformed response');
  }
  return json as DGPreTournamentResponse;
}

// ── Helpers ────────────────────────────────────────────────────
/**
 * Normalize Datagolf percent values (0..100, may be null/undefined,
 * may include the field as missing) into [0..1] with NULL coercion.
 */
export function pct(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n / 100));
}

/**
 * Datagolf player names are "Last, First". Our local DB uses
 * "First Last". Convert for matching.
 */
export function dgNameToCanonical(name: string): string {
  const idx = name.indexOf(',');
  if (idx < 0) return name.trim();
  const last = name.slice(0, idx).trim();
  const first = name.slice(idx + 1).trim();
  return `${first} ${last}`;
}
