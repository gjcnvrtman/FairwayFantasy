// GET /api/leagues/verify?slug=xxx&code=yyy
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { checkRateLimit, clientIpFromHeaders } from '@/lib/rate-limit';

// Public endpoint (no auth) — used by the signup flow to confirm the
// pasted slug+code resolve to a real league before letting the user
// submit. Tight rate limit (10 / 10 min / IP) makes invite-code
// brute-forcing impractical.
const RL_VERIFY_LIMIT  = 10;
const RL_VERIFY_WINDOW = 600;

export async function GET(req: NextRequest) {
  const ip = clientIpFromHeaders(req.headers);
  const rl = await checkRateLimit({
    key:           `verify:${ip}`,
    limit:         RL_VERIFY_LIMIT,
    windowSeconds: RL_VERIFY_WINDOW,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${rl.retryAfterSeconds}s.` },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds) } },
    );
  }

  const slug = req.nextUrl.searchParams.get('slug');
  const code = req.nextUrl.searchParams.get('code');

  if (!slug || !code) return NextResponse.json({ error: 'Missing params' }, { status: 400 });

  const league = await db.selectFrom('leagues')
    .select(['id', 'name'])
    .where('slug', '=', slug)
    .where('invite_code', '=', code)
    .executeTakeFirst();

  if (!league) return NextResponse.json({ error: 'Invalid invite' }, { status: 404 });

  return NextResponse.json({ leagueName: league.name });
}
