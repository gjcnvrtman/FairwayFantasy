// /api/predictions/bw-courses/search?q=... — typeahead over the
// local mirror of boys-weekend Course rows. Used by the course-
// profile form's autofill search box. Admin-gated.

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { isPlatformAdmin } from '@/lib/platform-admin';
import { db } from '@/lib/db';
import { sql } from 'kysely';

// Server side caching is not appropriate here — the cache is large
// (~15k rows) and the typeahead pattern fires per keystroke. We use
// the LOWER(name) index for case-insensitive substring search and
// bound result count.

const MAX_RESULTS = 20;

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !user.email || !isPlatformAdmin(user.email)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  if (q.length < 2) {
    return NextResponse.json({ ok: true, results: [] });
  }

  // Case-insensitive substring on name. Sort by:
  //   1. exact-prefix match first
  //   2. shorter name next (prefer "TPC Deere Run" over a longer name)
  //   3. id ascending as a deterministic tiebreaker
  const like = `%${q.toLowerCase()}%`;
  const prefix = `${q.toLowerCase()}%`;

  const rows = await db.selectFrom('bw_courses_cache')
    .select([
      'id', 'name', 'city', 'state',
      'total_par', 'total_yardage',
      'par_3_count', 'par_4_count', 'par_5_count',
    ])
    .where(sql<boolean>`LOWER(name) LIKE ${like}`)
    .orderBy(sql`(LOWER(name) LIKE ${prefix}) DESC`)
    .orderBy('name', 'asc')
    .orderBy('id', 'asc')
    .limit(MAX_RESULTS)
    .execute();

  return NextResponse.json({ ok: true, results: rows });
}
