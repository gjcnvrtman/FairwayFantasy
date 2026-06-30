// ============================================================
// /api/predictions/stats/upload — browser-side CSV import.
//
// Accepts multipart/form-data with:
//   - file: the wide CSV (golfer_name + 12 optional stat columns)
//   - as_of_date: YYYY-MM-DD
//   - auto_link_fuzzy: 'true' | 'false' (default true) — when true,
//     fuzzy candidates with distance ≤ 2 auto-link. When false they
//     land as NULL golfer_id for later review.
//
// Persists into golfer_stat_snapshots using the same upsert/insert
// shape as the CLI loader (scripts/import-stats.ts). Both paths
// share src/lib/stat-snapshots.ts for parsing + matching so the
// behavior stays aligned.
//
// Admin-gated → 404 on miss.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { isPlatformAdmin } from '@/lib/platform-admin';
import { requireSameOrigin } from '@/lib/same-origin';
import { db } from '@/lib/db';
import { sql } from 'kysely';
import {
  parseStatsCSV, matchAll, summarizeMatches,
  type ParsedRow, type StatCol,
} from '@/lib/stat-snapshots';

// 10 MB is plenty for a ~300-row stat snapshot — guards against
// accidental uploads of giant files.
const MAX_BYTES = 10 * 1024 * 1024;

export const maxDuration = 60;

function numStrOrNull(stats: Partial<Record<StatCol, number>>, col: StatCol): string | null {
  const v = stats[col];
  return v == null ? null : v.toString();
}

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user || !user.email || !isPlatformAdmin(user.email)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return NextResponse.json({
      error: 'Invalid multipart/form-data: '
        + (err instanceof Error ? err.message : String(err)),
    }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({
      error: `file too large (${file.size} bytes; max ${MAX_BYTES})`,
    }, { status: 400 });
  }
  const asOfDate = form.get('as_of_date');
  if (typeof asOfDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    return NextResponse.json({
      error: 'as_of_date must be YYYY-MM-DD',
    }, { status: 400 });
  }
  const autoLinkFuzzy = (form.get('auto_link_fuzzy') ?? 'true').toString() === 'true';

  // Parse.
  let parsed: ReturnType<typeof parseStatsCSV>;
  try {
    const text = await file.text();
    parsed = parseStatsCSV(text);
  } catch (err) {
    return NextResponse.json({
      error: `Could not parse CSV: ${err instanceof Error ? err.message : String(err)}`,
    }, { status: 400 });
  }

  // Match against the local golfer index.
  const golfers = await db.selectFrom('golfers')
    .select(['id', 'name'])
    .execute();
  const outcomes = matchAll(parsed.rows, golfers);
  const summary = summarizeMatches(outcomes, parsed.warnings);

  // Insert rows. Behavior:
  //   - exact match → upsert ON CONFLICT (golfer_id, as_of_date)
  //   - fuzzy match + autoLinkFuzzy → upsert as if exact
  //   - fuzzy match without autoLinkFuzzy → insert as NULL golfer_id
  //   - no match → insert as NULL golfer_id
  let inserted = 0;
  let upserted = 0;
  const unmatchedNames: string[] = [];
  const fuzzyDeferred: { raw: string; suggestion: string; distance: number }[] = [];

  for (const o of outcomes) {
    const linkedGolfer =
      o.kind === 'exact' ? o.golfer.id :
      (o.kind === 'fuzzy' && autoLinkFuzzy) ? o.golfer.id :
      null;

    if (o.kind === 'none') unmatchedNames.push(o.parsed.golferNameRaw);
    if (o.kind === 'fuzzy' && !autoLinkFuzzy) {
      fuzzyDeferred.push({
        raw: o.parsed.golferNameRaw,
        suggestion: o.golfer.name,
        distance: o.distance,
      });
    }

    const s = o.parsed.stats;
    if (linkedGolfer) {
      // Match → upsert.
      const res = await sql<{ inserted: boolean }>`
        INSERT INTO golfer_stat_snapshots (
          golfer_id, golfer_name_raw, as_of_date, source,
          sg_total, sg_ott, sg_app, sg_arg, sg_putt,
          driving_distance, driving_accuracy_pct, gir_pct,
          scoring_avg, birdie_avg, bogey_avg, made_cut_pct,
          raw_json, uploaded_by
        ) VALUES (
          ${linkedGolfer}, ${o.parsed.golferNameRaw}, ${asOfDate}::date, 'csv_upload',
          ${numStrOrNull(s, 'sg_total')}::numeric, ${numStrOrNull(s, 'sg_ott')}::numeric,
          ${numStrOrNull(s, 'sg_app')}::numeric, ${numStrOrNull(s, 'sg_arg')}::numeric,
          ${numStrOrNull(s, 'sg_putt')}::numeric,
          ${numStrOrNull(s, 'driving_distance')}::numeric,
          ${numStrOrNull(s, 'driving_accuracy_pct')}::numeric,
          ${numStrOrNull(s, 'gir_pct')}::numeric,
          ${numStrOrNull(s, 'scoring_avg')}::numeric,
          ${numStrOrNull(s, 'birdie_avg')}::numeric,
          ${numStrOrNull(s, 'bogey_avg')}::numeric,
          ${numStrOrNull(s, 'made_cut_pct')}::numeric,
          ${JSON.stringify(o.parsed.rawJson)}::jsonb,
          ${user.id}::uuid
        )
        ON CONFLICT (golfer_id, as_of_date) DO UPDATE SET
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
        RETURNING (xmax = 0) AS inserted
      `.execute(db);
      if (res.rows[0]?.inserted) inserted++; else upserted++;
    } else {
      // Unmatched → plain insert. Partial unique only fires for
      // NOT-NULL golfer_id, so duplicates coexist safely.
      await sql`
        INSERT INTO golfer_stat_snapshots (
          golfer_id, golfer_name_raw, as_of_date, source,
          sg_total, sg_ott, sg_app, sg_arg, sg_putt,
          driving_distance, driving_accuracy_pct, gir_pct,
          scoring_avg, birdie_avg, bogey_avg, made_cut_pct,
          raw_json, uploaded_by
        ) VALUES (
          NULL, ${o.parsed.golferNameRaw}, ${asOfDate}::date, 'csv_upload',
          ${numStrOrNull(s, 'sg_total')}::numeric, ${numStrOrNull(s, 'sg_ott')}::numeric,
          ${numStrOrNull(s, 'sg_app')}::numeric, ${numStrOrNull(s, 'sg_arg')}::numeric,
          ${numStrOrNull(s, 'sg_putt')}::numeric,
          ${numStrOrNull(s, 'driving_distance')}::numeric,
          ${numStrOrNull(s, 'driving_accuracy_pct')}::numeric,
          ${numStrOrNull(s, 'gir_pct')}::numeric,
          ${numStrOrNull(s, 'scoring_avg')}::numeric,
          ${numStrOrNull(s, 'birdie_avg')}::numeric,
          ${numStrOrNull(s, 'bogey_avg')}::numeric,
          ${numStrOrNull(s, 'made_cut_pct')}::numeric,
          ${JSON.stringify(o.parsed.rawJson)}::jsonb,
          ${user.id}::uuid
        )
      `.execute(db);
      inserted++;
    }
  }

  return NextResponse.json({
    ok: true,
    asOfDate,
    inserted,
    upserted,
    summary,
    unmatchedNames,
    fuzzyDeferred,
  });
}
