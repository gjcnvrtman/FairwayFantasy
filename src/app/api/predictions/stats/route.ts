// /api/predictions/stats — list past snapshot uploads, grouped by date.
// Admin-gated.

import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { isPlatformAdmin } from '@/lib/platform-admin';
import { loadSnapshotGroups } from '@/lib/db/predictions-views';

export async function GET() {
  const user = await getCurrentUser();
  if (!user || !user.email || !isPlatformAdmin(user.email)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, snapshots: await loadSnapshotGroups(50) });
}
