// ============================================================
// STAT-SNAPSHOTS — shared CSV parser + golfer-name matcher.
//
// Used by:
//   1. scripts/import-stats.ts (CLI, interactive fuzzy review)
//   2. src/app/api/predictions/stats/upload/route.ts (browser upload)
//
// Pure functions. No I/O. Callers wire up the DB read of the golfer
// table + the DB write of the snapshot rows.
//
// CSV shape (canonical, header row required):
//   golfer_name,sg_total,sg_ott,sg_app,sg_arg,sg_putt,
//   driving_distance,driving_accuracy_pct,gir_pct,scoring_avg,
//   birdie_avg,bogey_avg,made_cut_pct
//
// golfer_name is required; every stat column is optional. Missing
// stat columns/cells land as NULL — the predictor handles partial
// data and flags missing inputs in its warnings.
//
// Matching uses normalized Levenshtein:
//   - exact normalized match → auto-link
//   - distance ≤ 2 AND name length ≥ 5 → fuzzy candidate
//   - otherwise → unmatched (golfer_id NULL in DB)
// ============================================================

// ── Canonical stat columns ────────────────────────────────

export const STAT_COLUMNS = [
  'sg_total', 'sg_ott', 'sg_app', 'sg_arg', 'sg_putt',
  'driving_distance', 'driving_accuracy_pct', 'gir_pct',
  'scoring_avg', 'birdie_avg', 'bogey_avg', 'made_cut_pct',
] as const;
export type StatCol = typeof STAT_COLUMNS[number];

export interface ParsedRow {
  golferNameRaw: string;
  stats: Partial<Record<StatCol, number>>;
  rawJson: Record<string, string>;
}

// ── CSV parser (minimal RFC4180 subset) ────────────────────

function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuote = false; }
      } else { cur += ch; }
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

export interface ParseResult {
  rows: ParsedRow[];
  warnings: string[];
  /** Header columns (lowercased), in file order. */
  header: string[];
}

/**
 * Parse a wide CSV into ParsedRow array. Header row required.
 * Throws on malformed/empty input; otherwise warnings carry the
 * non-fatal issues so the caller can surface them to the user.
 */
export function parseStatsCSV(text: string): ParseResult {
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length < 2) {
    throw new Error('CSV must have a header row + at least one data row');
  }
  const header = parseLine(lines[0]).map(h => h.toLowerCase());
  const raw = lines.slice(1).map(parseLine);

  const warnings: string[] = [];
  const nameIdx = header.indexOf('golfer_name');
  if (nameIdx < 0) {
    throw new Error('CSV header must include "golfer_name"');
  }

  const statIdx: Partial<Record<StatCol, number>> = {};
  for (const col of STAT_COLUMNS) {
    const i = header.indexOf(col);
    if (i >= 0) statIdx[col] = i;
    else warnings.push(`Column '${col}' missing — rows will have NULL for this stat.`);
  }

  const rows: ParsedRow[] = [];
  raw.forEach((vals, ri) => {
    const name = vals[nameIdx];
    if (!name) {
      warnings.push(`Row ${ri + 2}: empty golfer_name, skipped.`);
      return;
    }
    const stats: Partial<Record<StatCol, number>> = {};
    for (const col of STAT_COLUMNS) {
      const i = statIdx[col];
      if (i !== undefined) {
        const cell = vals[i];
        if (cell !== undefined && cell !== '') {
          const n = Number(cell.replace(/,/g, ''));
          if (Number.isFinite(n)) stats[col] = n;
        }
      }
    }
    const rawJson: Record<string, string> = {};
    header.forEach((h, i) => { rawJson[h] = vals[i] ?? ''; });
    rows.push({ golferNameRaw: name, stats, rawJson });
  });
  return { rows, warnings, header };
}

// ── Name normalization + Levenshtein ───────────────────────

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')      // strip accents
    .replace(/\b(jr|sr|iii|ii|iv)\.?\b/g, '')             // drop suffixes
    .replace(/[^a-z0-9\s]/g, ' ')                         // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let cur = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(cur + 1, prev[j] + 1, prev[j - 1] + cost);
      prev[j - 1] = cur;
      cur = next;
    }
    prev[b.length] = cur;
  }
  return prev[b.length];
}

// ── Matching against the local golfer index ────────────────

export interface GolferIndexRow {
  id: string;
  name: string;
}

export interface MatchExact {
  kind: 'exact';
  parsed: ParsedRow;
  golfer: GolferIndexRow;
}
export interface MatchFuzzy {
  kind: 'fuzzy';
  parsed: ParsedRow;
  golfer: GolferIndexRow;
  distance: number;
}
export interface MatchNone {
  kind: 'none';
  parsed: ParsedRow;
}
export type MatchOutcome = MatchExact | MatchFuzzy | MatchNone;

/**
 * Classify every ParsedRow against the golfer index (DB rows).
 * Returns the outcome list in the same order as `rows`.
 */
export function matchAll(
  rows: ParsedRow[],
  golfers: GolferIndexRow[],
): MatchOutcome[] {
  // Build a normalized-name → golfer map for O(1) exact lookups.
  const byNorm = new Map<string, GolferIndexRow>();
  const normalized = golfers.map(g => ({
    g, norm: normalizeName(g.name),
  }));
  for (const { g, norm } of normalized) byNorm.set(norm, g);

  return rows.map((p): MatchOutcome => {
    const norm = normalizeName(p.golferNameRaw);
    const exact = byNorm.get(norm);
    if (exact) return { kind: 'exact', parsed: p, golfer: exact };
    if (norm.length < 5) return { kind: 'none', parsed: p };

    let best: { g: GolferIndexRow; d: number } | null = null;
    for (const { g, norm: gNorm } of normalized) {
      if (Math.abs(gNorm.length - norm.length) > 3) continue;   // early-prune
      const d = levenshtein(gNorm, norm);
      if (d <= 2 && (!best || d < best.d)) best = { g, d };
    }
    if (best) return { kind: 'fuzzy', parsed: p, golfer: best.g, distance: best.d };
    return { kind: 'none', parsed: p };
  });
}

// ── Summary helper ─────────────────────────────────────────

export interface MatchSummary {
  exact: number;
  fuzzy: number;
  none: number;
  warnings: string[];
}

export function summarizeMatches(
  outcomes: MatchOutcome[],
  parseWarnings: string[],
): MatchSummary {
  let exact = 0, fuzzy = 0, none = 0;
  for (const o of outcomes) {
    if (o.kind === 'exact') exact++;
    else if (o.kind === 'fuzzy') fuzzy++;
    else none++;
  }
  return { exact, fuzzy, none, warnings: parseWarnings };
}
