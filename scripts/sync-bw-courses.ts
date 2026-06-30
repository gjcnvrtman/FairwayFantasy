#!/usr/bin/env tsx
/* ============================================================
 * SYNC-BW-COURSES — populate bw_courses_cache from boys-weekend.
 *
 * One-shot loader (and weekly refresher via systemd later) that
 * copies Course + CourseHole rows from the boys-weekend Postgres
 * into FairwayFantasy's bw_courses_cache + bw_course_holes_cache.
 *
 * Runs on the .150 host (where both Postgres instances are
 * reachable). Two env vars required:
 *
 *   BW_DATABASE_URL  — boys-weekend connection
 *     e.g. postgresql://golf:golf@localhost:5432/golf_boys_weekend
 *
 *   DATABASE_URL     — fairway connection (host's view of Docker)
 *     e.g. postgresql://fairway:<pw>@localhost:5434/fairway
 *
 * Idempotent: re-running upserts on (Course.id, CourseHole.id). The
 * pre-computed roll-ups on bw_courses_cache (total_par, total_yardage,
 * par_3_count, ...) are recomputed every run so changes upstream
 * propagate.
 *
 * Yardage selection — boys-weekend stores yardages JSONB keyed by tee
 * name (e.g. {"TPC (Men)": 395, ...}). We pick the championship tee
 * heuristically by preferred name order; if none match, we fall back
 * to the maximum value per hole.
 *
 *   USAGE
 *     BW_DATABASE_URL='postgresql://golf:golf@localhost:5432/golf_boys_weekend' \
 *     DATABASE_URL='postgresql://fairway:...@localhost:5434/fairway' \
 *       npx tsx scripts/sync-bw-courses.ts [--dry-run] [--limit N]
 *
 *   FLAGS
 *     --dry-run   parse + plan + log, no writes
 *     --limit N   only sync first N courses (debug / smoke)
 * ============================================================ */

import { Pool } from 'pg';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : null;

if (!process.env.BW_DATABASE_URL) {
  console.error('BW_DATABASE_URL not set.');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set.');
  process.exit(2);
}

/**
 * Championship yardage per hole = the longest tee, full stop.
 *
 * Prior version used a name-preference list (Championship,
 * Tournament, Black, TPC, Tips, Blue) but that's fragile across
 * courses — TPC Deere Run has both "Black (Men)" and "TPC (Men)"
 * defined, and the TPC tees are LONGER than Black, even though
 * Black appeared earlier in the preference list. Result: total
 * yardage came out 7066 yd when the true championship-tee total
 * is 7258. Picking the max per hole is course-agnostic and matches
 * how "championship yardage" is universally defined: the longest
 * playable set of tees.
 */
function pickHoleYardage(yardages: Record<string, unknown> | null | undefined): number | null {
  if (!yardages || typeof yardages !== 'object') return null;
  let max = 0;
  for (const v of Object.values(yardages)) {
    if (typeof v === 'number' && Number.isFinite(v) && v > max) max = v;
  }
  return max > 0 ? max : null;
}

interface BWCourseRow {
  id: number;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  website: string | null;
  teeTimeUrl: string | null;
  googleMapsUrl: string | null;
  lat: number | null;
  lng: number | null;
  rating: number | null;
  slope: number | null;
  notes: string | null;
  active: boolean;
}

interface BWHoleRow {
  id: number;
  courseId: number;
  holeNumber: number;
  par: number;
  strokeIndex: number | null;
  yardages: Record<string, unknown> | null;
}

async function main() {
  const bw = new Pool({ connectionString: process.env.BW_DATABASE_URL });
  const ff = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    console.log('Reading boys-weekend Course rows...');
    const courseQ = `
      SELECT id, name, address, city, state, zip, phone, website,
             "teeTimeUrl", "googleMapsUrl", lat, lng, rating, slope, notes, active
      FROM "Course"
      ORDER BY id
      ${limit ? `LIMIT ${Number(limit)}` : ''}
    `;
    const courseRes = await bw.query<BWCourseRow>(courseQ);
    console.log(`  ${courseRes.rows.length} course rows`);

    console.log('Reading boys-weekend CourseHole rows...');
    // Holes filtered to the course id set we just loaded.
    const courseIds = courseRes.rows.map(c => c.id);
    const holesRes = courseIds.length === 0 ? { rows: [] as BWHoleRow[] } :
      await bw.query<BWHoleRow>(`
        SELECT id, "courseId", "holeNumber", par, "strokeIndex", yardages
        FROM "CourseHole"
        WHERE "courseId" = ANY($1::int[])
        ORDER BY "courseId", "holeNumber"
      `, [courseIds]);
    console.log(`  ${holesRes.rows.length} hole rows`);

    // ── Compute per-course roll-ups ──
    interface RollUp {
      total_par: number;
      total_yardage: number;
      par_3_count: number;
      par_4_count: number;
      par_5_count: number;
      hole_count: number;
    }
    const rollUpByCourse = new Map<number, RollUp>();
    for (const h of holesRes.rows) {
      const r = rollUpByCourse.get(h.courseId) ?? {
        total_par: 0, total_yardage: 0,
        par_3_count: 0, par_4_count: 0, par_5_count: 0, hole_count: 0,
      };
      r.total_par += h.par;
      r.hole_count++;
      if (h.par === 3) r.par_3_count++;
      else if (h.par === 4) r.par_4_count++;
      else if (h.par === 5) r.par_5_count++;
      const y = pickHoleYardage(h.yardages);
      if (y != null) r.total_yardage += y;
      rollUpByCourse.set(h.courseId, r);
    }

    if (dryRun) {
      console.log(`Dry-run: ${courseRes.rows.length} courses + ${holesRes.rows.length} holes would be upserted.`);
      const sample = courseRes.rows.slice(0, 3);
      for (const c of sample) {
        const r = rollUpByCourse.get(c.id);
        console.log(`  [sample] ${c.name} (${c.city ?? '?'}, ${c.state ?? '?'}) — par ${r?.total_par ?? '?'}, ${r?.total_yardage ?? '?'} yd, ${r?.hole_count ?? '?'} holes`);
      }
      return;
    }

    // ── Upsert into FairwayFantasy ──
    console.log('Upserting courses...');
    let cIns = 0, cUpd = 0;
    for (const c of courseRes.rows) {
      const r = rollUpByCourse.get(c.id);
      const res = await ff.query<{ inserted: boolean }>(
        `INSERT INTO bw_courses_cache (
            id, name, address, city, state, zip, phone, website,
            tee_time_url, google_maps_url, lat, lng, rating, slope, notes,
            active,
            total_par, total_yardage, par_3_count, par_4_count, par_5_count, hole_count
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
          )
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            address = EXCLUDED.address,
            city = EXCLUDED.city,
            state = EXCLUDED.state,
            zip = EXCLUDED.zip,
            phone = EXCLUDED.phone,
            website = EXCLUDED.website,
            tee_time_url = EXCLUDED.tee_time_url,
            google_maps_url = EXCLUDED.google_maps_url,
            lat = EXCLUDED.lat,
            lng = EXCLUDED.lng,
            rating = EXCLUDED.rating,
            slope = EXCLUDED.slope,
            notes = EXCLUDED.notes,
            active = EXCLUDED.active,
            total_par = EXCLUDED.total_par,
            total_yardage = EXCLUDED.total_yardage,
            par_3_count = EXCLUDED.par_3_count,
            par_4_count = EXCLUDED.par_4_count,
            par_5_count = EXCLUDED.par_5_count,
            hole_count = EXCLUDED.hole_count,
            synced_at = NOW()
          RETURNING (xmax = 0) AS inserted`,
        [
          c.id, c.name, c.address, c.city, c.state, c.zip, c.phone, c.website,
          c.teeTimeUrl, c.googleMapsUrl, c.lat, c.lng, c.rating, c.slope, c.notes,
          c.active,
          r?.total_par ?? null, r?.total_yardage ?? null,
          r?.par_3_count ?? null, r?.par_4_count ?? null, r?.par_5_count ?? null,
          r?.hole_count ?? null,
        ],
      );
      if (res.rows[0]?.inserted) cIns++; else cUpd++;
    }
    console.log(`  ${cIns} inserted, ${cUpd} updated.`);

    console.log('Upserting holes...');
    let hIns = 0, hUpd = 0;
    for (const h of holesRes.rows) {
      const res = await ff.query<{ inserted: boolean }>(
        `INSERT INTO bw_course_holes_cache (
            id, course_id, hole_number, par, stroke_index, yardages
          ) VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (id) DO UPDATE SET
            course_id = EXCLUDED.course_id,
            hole_number = EXCLUDED.hole_number,
            par = EXCLUDED.par,
            stroke_index = EXCLUDED.stroke_index,
            yardages = EXCLUDED.yardages
          RETURNING (xmax = 0) AS inserted`,
        [h.id, h.courseId, h.holeNumber, h.par, h.strokeIndex, h.yardages],
      );
      if (res.rows[0]?.inserted) hIns++; else hUpd++;
    }
    console.log(`  ${hIns} inserted, ${hUpd} updated.`);

    console.log('Done.');
  } finally {
    await bw.end();
    await ff.end();
  }
}

main().catch(e => { console.error('sync-bw-courses failed:', e); process.exit(1); });
