// ============================================================
// RATE LIMIT — fixed-window, Postgres-backed.
//
// One UPSERT per request against the `rate_limits` table. The window
// resets to NOW() whenever the existing window has elapsed; otherwise
// `count` is incremented and compared against the limit.
//
// Slight under-counting under high concurrency is acceptable for abuse
// prevention. We're not building anti-DDoS infrastructure — the goal
// is to make brute-force / scripted abuse expensive enough that an
// attacker either gives up or gets blocked at the network layer (nginx,
// fail2ban, cloudflare). Reasonable defaults below cover the
// public-internet exposure of a small fantasy-golf league.
//
// Usage:
//   const limit = await checkRateLimit({
//     key: `register:${clientIp}`,
//     limit: 5,
//     windowSeconds: 600,  // 10 min
//   });
//   if (!limit.ok) return NextResponse.json(
//     { error: 'Too many attempts. Try again later.' },
//     { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
//   );
// ============================================================

import { sql } from 'kysely';
import { db } from './db';

export interface RateLimitResult {
  ok:                  boolean;
  count:               number;
  retryAfterSeconds:   number;
}

export async function checkRateLimit(params: {
  key:            string;
  limit:          number;
  windowSeconds:  number;
}): Promise<RateLimitResult> {
  const { key, limit, windowSeconds } = params;

  // The CASE pinning keeps the existing window_start when we're still
  // inside the window (so count keeps accumulating against the same
  // reset clock); otherwise resets both window_start and count.
  // sql.raw on a vetted integer is safe — we control the value.
  const windowInterval = sql.raw(`INTERVAL '${Math.max(1, Math.floor(windowSeconds))} seconds'`);

  const result = await sql<{ count: number; window_start: Date }>`
    INSERT INTO rate_limits (key, window_start, count, updated_at)
    VALUES (${key}, NOW(), 1, NOW())
    ON CONFLICT (key) DO UPDATE SET
      window_start = CASE
        WHEN rate_limits.window_start < NOW() - ${windowInterval}
          THEN NOW()
        ELSE rate_limits.window_start
      END,
      count = CASE
        WHEN rate_limits.window_start < NOW() - ${windowInterval}
          THEN 1
        ELSE rate_limits.count + 1
      END,
      updated_at = NOW()
    RETURNING count, window_start
  `.execute(db);

  const row = result.rows[0];
  const count = Number(row.count);
  const windowStart = new Date(row.window_start);
  const windowEnd = new Date(windowStart.getTime() + windowSeconds * 1000);
  const retryAfter = Math.max(1, Math.ceil((windowEnd.getTime() - Date.now()) / 1000));

  return {
    ok: count <= limit,
    count,
    retryAfterSeconds: retryAfter,
  };
}

/**
 * Pull the client IP from request headers. Fairway sits behind nginx
 * on .150 which sets X-Forwarded-For; if that's absent (direct test
 * hit, mis-configured proxy, etc.) we fall back to a literal string
 * so the rate-limit key doesn't collapse to empty.
 */
export function clientIpFromHeaders(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    // X-Forwarded-For: comma-separated. First entry is the original
    // client; trust only the first since nginx prepends its own value.
    return xff.split(',')[0].trim() || 'unknown';
  }
  const real = headers.get('x-real-ip');
  if (real) return real.trim() || 'unknown';
  return 'unknown';
}
