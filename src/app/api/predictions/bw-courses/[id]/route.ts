// /api/predictions/bw-courses/[id] — fetch one cached boys-weekend
// course with its pre-computed roll-ups. The form uses this to
// autofill the new-profile fields. Admin-gated.

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { isPlatformAdmin } from '@/lib/platform-admin';
import { db } from '@/lib/db';

interface Props { params: { id: string } }

export async function GET(_req: NextRequest, { params }: Props) {
  const user = await getCurrentUser();
  if (!user || !user.email || !isPlatformAdmin(user.email)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const idNum = Number(params.id);
  if (!Number.isFinite(idNum) || idNum <= 0) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }
  const row = await db.selectFrom('bw_courses_cache')
    .selectAll()
    .where('id', '=', idNum)
    .executeTakeFirst();
  if (!row) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, course: row });
}
