// /api/predictions/backtests/[id] — fetch one backtest run + per-event
// results. Admin-gated.

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { isPlatformAdmin } from '@/lib/platform-admin';
import { loadBacktestDetail } from '@/lib/db/predictions-views';

interface Props { params: { id: string } }

export async function GET(_req: NextRequest, { params }: Props) {
  const user = await getCurrentUser();
  if (!user || !user.email || !isPlatformAdmin(user.email)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const detail = await loadBacktestDetail(params.id);
  if (!detail) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, run: detail.run, results: detail.results });
}
