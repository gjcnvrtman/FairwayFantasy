// /api/predictions/stats — list past snapshot uploads, grouped by date.
// Admin-gated.

import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { isPlatformAdmin } from '@/lib/platform-admin';
import { db } from '@/lib/db';
import { sql } from 'kysely';

interface DateGroup {
  as_of_date: string;
  total: string;
  matched: string;
  unmatched: string;
  last_uploaded_at: string;
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user || !user.email || !isPlatformAdmin(user.email)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const result = await sql<DateGroup>`
    SELECT
      as_of_date::text AS as_of_date,
      COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE golfer_id IS NOT NULL)::text AS matched,
      COUNT(*) FILTER (WHERE golfer_id IS NULL)::text AS unmatched,
      MAX(uploaded_at)::text AS last_uploaded_at
    FROM golfer_stat_snapshots
    GROUP BY as_of_date
    ORDER BY as_of_date DESC
    LIMIT 50
  `.execute(db);

  return NextResponse.json({ ok: true, snapshots: result.rows });
}
