#!/usr/bin/env tsx
/* ============================================================
 * IMPORT-STATS — CSV → golfer_stat_snapshots loader.
 *
 * Phase-3 first deliverable. Lets the platform admin shovel a wide
 * CSV of golfer stats into the DB BEFORE the admin UI lands. Same
 * parser + matcher will back the future /api/predictions/stats/upload
 * endpoint, so behavior must stay aligned.
 *
 * CSV FORMAT
 *   Required header row. `golfer_name` column is mandatory; every
 *   stat column is optional (missing column → NULL, allowed).
 *
 *   golfer_name,sg_total,sg_ott,sg_app,sg_arg,sg_putt,driving_distance,
 *   driving_accuracy_pct,gir_pct,scoring_avg,birdie_avg,bogey_avg,
 *   made_cut_pct
 *
 * USAGE
 *   DATABASE_URL='postgresql://...' \
 *     npx tsx scripts/import-stats.ts \
 *       --csv path/to/stats.csv \
 *       --as-of 2026-06-26
 *
 * FLAGS
 *   --csv <path>        Required. Path to the CSV file.
 *   --as-of YYYY-MM-DD  Required. The snapshot date all rows share.
 *   --yes               Auto-accept all fuzzy matches (no prompts).
 *                       Use with caution — meant for re-runs after a
 *                       prior interactive pass set the matches.
 *   --dry-run           Parse + match, print the plan, do NOT write.
 *
 * MATCHING
 *   Names normalize via lowercase + strip-accents + drop suffixes
 *   ("Jr.", "Sr.", "III", "II"). Then:
 *     - exact normalized match  → auto-link
 *     - Levenshtein distance ≤ 2 AND length ≥ 5 → fuzzy candidate
 *       (interactive y/n unless --yes)
 *     - otherwise → row inserted with golfer_id NULL (visible in
 *       the "unmatched" admin queue once the UI ships).
 * ============================================================ */

import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

// ── Args ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const csvPath = flag('--csv');
const asOf = flag('--as-of');
const autoYes = args.includes('--yes');
const dryRun = args.includes('--dry-run');

if (!csvPath || !asOf) {
  console.error('Usage: npx tsx scripts/import-stats.ts --csv <path> --as-of YYYY-MM-DD [--yes] [--dry-run]');
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
  console.error(`--as-of must be YYYY-MM-DD, got: ${asOf}`);
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set.');
  process.exit(2);
}

// ── CSV parser (minimal — RFC4180 subset) ───────────────────────
// Handles quoted fields with embedded commas and "" → " escapes.
// Doesn't handle multi-line fields (the stats data never has them).
function parseCSV(text: string): { header: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length < 2) throw new Error('CSV must have header + at least one data row');
  const parseLine = (line: string): string[] => {
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
  };
  const header = parseLine(lines[0]).map(h => h.toLowerCase());
  const rows = lines.slice(1).map(parseLine);
  return { header, rows };
}

// Column names we care about. Anything else in the header goes to raw_json only.
const STAT_COLUMNS = [
  'sg_total', 'sg_ott', 'sg_app', 'sg_arg', 'sg_putt',
  'driving_distance', 'driving_accuracy_pct', 'gir_pct',
  'scoring_avg', 'birdie_avg', 'bogey_avg', 'made_cut_pct',
] as const;
type StatCol = typeof STAT_COLUMNS[number];

interface ParsedRow {
  golferNameRaw: string;
  stats: Partial<Record<StatCol, number>>;
  rawJson: Record<string, string>;
}

function num(s: string | undefined): number | undefined {
  if (s === undefined || s === '') return undefined;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function buildRows(header: string[], raw: string[][]): { rows: ParsedRow[]; warnings: string[] } {
  const warnings: string[] = [];
  const nameIdx = header.indexOf('golfer_name');
  if (nameIdx < 0) throw new Error('CSV header must include "golfer_name"');

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
        const v = num(vals[i]);
        if (v !== undefined) stats[col] = v;
      }
    }
    const rawJson: Record<string, string> = {};
    header.forEach((h, i) => { rawJson[h] = vals[i] ?? ''; });
    rows.push({ golferNameRaw: name, stats, rawJson });
  });
  return { rows, warnings };
}

// ── Name normalization + fuzzy match ────────────────────────────
function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')   // strip accents
    .replace(/\b(jr|sr|iii|ii|iv)\.?\b/g, '')          // drop suffixes
    .replace(/[^a-z0-9\s]/g, ' ')                      // punctuation -> space
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
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

interface GolferIndex { id: string; name: string; normalized: string; }

async function loadGolferIndex(pool: Pool): Promise<GolferIndex[]> {
  const { rows } = await pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM golfers ORDER BY name',
  );
  return rows.map(r => ({ id: r.id, name: r.name, normalized: normalizeName(r.name) }));
}

interface MatchResult {
  parsed: ParsedRow;
  match: { kind: 'exact'; golfer: GolferIndex }
       | { kind: 'fuzzy'; golfer: GolferIndex; distance: number }
       | { kind: 'none' };
}

function matchAll(parsed: ParsedRow[], index: GolferIndex[]): MatchResult[] {
  const byNorm = new Map<string, GolferIndex>();
  for (const g of index) byNorm.set(g.normalized, g);
  return parsed.map(p => {
    const norm = normalizeName(p.golferNameRaw);
    const exact = byNorm.get(norm);
    if (exact) return { parsed: p, match: { kind: 'exact', golfer: exact } };
    if (norm.length < 5) return { parsed: p, match: { kind: 'none' } };
    let best: { g: GolferIndex; d: number } | null = null;
    for (const g of index) {
      if (Math.abs(g.normalized.length - norm.length) > 3) continue;
      const d = levenshtein(g.normalized, norm);
      if (d <= 2 && (!best || d < best.d)) best = { g, d };
    }
    if (best) return { parsed: p, match: { kind: 'fuzzy', golfer: best.g, distance: best.d } };
    return { parsed: p, match: { kind: 'none' } };
  });
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  const text = readFileSync(csvPath!, 'utf8');
  const { header, rows: rawRows } = parseCSV(text);
  const { rows: parsed, warnings } = buildRows(header, rawRows);
  console.log(`Parsed ${parsed.length} data row(s) from ${csvPath}.`);
  for (const w of warnings) console.warn(`  warn: ${w}`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const index = await loadGolferIndex(pool);
    console.log(`Loaded ${index.length} golfers from DB for name matching.`);

    const matched = matchAll(parsed, index);
    const exact = matched.filter(m => m.match.kind === 'exact');
    const fuzzy = matched.filter(m => m.match.kind === 'fuzzy');
    const none = matched.filter(m => m.match.kind === 'none');
    console.log(`\nMatch summary: ${exact.length} exact, ${fuzzy.length} fuzzy, ${none.length} unmatched.\n`);

    // Confirm fuzzy interactively unless --yes.
    const acceptedFuzzy = new Set<number>();
    if (fuzzy.length > 0 && !autoYes) {
      const rl = createInterface({ input: stdin, output: stdout });
      console.log('Confirm fuzzy candidates (y = link to suggestion, n = leave unmatched):');
      for (let i = 0; i < fuzzy.length; i++) {
        const m = fuzzy[i];
        if (m.match.kind !== 'fuzzy') continue;
        const ans = (await rl.question(
          `  [${i + 1}/${fuzzy.length}] "${m.parsed.golferNameRaw}" → "${m.match.golfer.name}" (dist=${m.match.distance})? [y/n] `,
        )).trim().toLowerCase();
        if (ans === 'y' || ans === 'yes') acceptedFuzzy.add(matched.indexOf(m));
      }
      await rl.close();
    } else if (fuzzy.length > 0 && autoYes) {
      fuzzy.forEach(m => acceptedFuzzy.add(matched.indexOf(m)));
      console.log(`--yes: auto-accepted all ${fuzzy.length} fuzzy candidate(s).`);
    }

    // Print plan + bail if dry-run.
    const willLinkExact = exact.length;
    const willLinkFuzzy = acceptedFuzzy.size;
    const willInsertUnmatched = none.length + (fuzzy.length - acceptedFuzzy.size);
    console.log(`\nPlan:`);
    console.log(`  ${willLinkExact} row(s) linked via exact match`);
    console.log(`  ${willLinkFuzzy} row(s) linked via accepted fuzzy match`);
    console.log(`  ${willInsertUnmatched} row(s) inserted with NULL golfer_id (unmatched queue)`);
    if (dryRun) {
      console.log('\n--dry-run: no rows written. Exiting.');
      return;
    }

    // Insert.
    let inserted = 0;
    let upserted = 0;
    for (let i = 0; i < matched.length; i++) {
      const m = matched[i];
      const linkedGolfer =
        m.match.kind === 'exact' ? m.match.golfer.id :
        (m.match.kind === 'fuzzy' && acceptedFuzzy.has(i)) ? m.match.golfer.id :
        null;

      const s = m.parsed.stats;
      const params = [
        linkedGolfer,
        m.parsed.golferNameRaw,
        asOf,
        'csv_upload',
        s.sg_total ?? null, s.sg_ott ?? null, s.sg_app ?? null,
        s.sg_arg ?? null, s.sg_putt ?? null,
        s.driving_distance ?? null,
        s.driving_accuracy_pct ?? null, s.gir_pct ?? null,
        s.scoring_avg ?? null, s.birdie_avg ?? null,
        s.bogey_avg ?? null, s.made_cut_pct ?? null,
        m.parsed.rawJson,
      ];

      // Two paths: linked rows do an UPSERT on (golfer_id, as_of_date);
      // unlinked rows just INSERT (the partial unique doesn't cover NULL).
      if (linkedGolfer) {
        const res = await pool.query(
          `INSERT INTO golfer_stat_snapshots (
             golfer_id, golfer_name_raw, as_of_date, source,
             sg_total, sg_ott, sg_app, sg_arg, sg_putt,
             driving_distance, driving_accuracy_pct, gir_pct,
             scoring_avg, birdie_avg, bogey_avg, made_cut_pct,
             raw_json
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (golfer_id, as_of_date) WHERE golfer_id IS NOT NULL DO UPDATE SET
             golfer_name_raw      = EXCLUDED.golfer_name_raw,
             source               = EXCLUDED.source,
             sg_total             = EXCLUDED.sg_total,
             sg_ott               = EXCLUDED.sg_ott,
             sg_app               = EXCLUDED.sg_app,
             sg_arg               = EXCLUDED.sg_arg,
             sg_putt              = EXCLUDED.sg_putt,
             driving_distance     = EXCLUDED.driving_distance,
             driving_accuracy_pct = EXCLUDED.driving_accuracy_pct,
             gir_pct              = EXCLUDED.gir_pct,
             scoring_avg          = EXCLUDED.scoring_avg,
             birdie_avg           = EXCLUDED.birdie_avg,
             bogey_avg            = EXCLUDED.bogey_avg,
             made_cut_pct         = EXCLUDED.made_cut_pct,
             raw_json             = EXCLUDED.raw_json,
             uploaded_at          = NOW()
           RETURNING (xmax = 0) AS inserted`,
          params,
        );
        if (res.rows[0]?.inserted) inserted++; else upserted++;
      } else {
        await pool.query(
          `INSERT INTO golfer_stat_snapshots (
             golfer_id, golfer_name_raw, as_of_date, source,
             sg_total, sg_ott, sg_app, sg_arg, sg_putt,
             driving_distance, driving_accuracy_pct, gir_pct,
             scoring_avg, birdie_avg, bogey_avg, made_cut_pct,
             raw_json
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          params,
        );
        inserted++;
      }
    }

    console.log(`\nDone. ${inserted} inserted, ${upserted} upserted (existing snapshot replaced).`);
    if (none.length > 0) {
      console.log(`\nUnmatched golfer_names (insert as NULL, review via admin queue later):`);
      none.forEach(m => console.log(`  - ${m.parsed.golferNameRaw}`));
    }
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error('import-stats failed:', e); process.exit(1); });
