// ============================================================
// KYSELY DATABASE CLIENT
//
// Lazy connection — Same Proxy pattern as `supabaseAdmin` in
// `src/lib/supabase.ts`. Without this, importing `db` at module-load
// from a route file would crash `next build` whenever DATABASE_URL
// isn't set (CI, fresh checkouts, env-less landing-page preview).
//
// Today: DATABASE_URL points at Supabase Cloud's direct pg
//   connection (Project Settings → Database → Connection string →
//   "URI" with the postgres user; use port 5432 for session mode,
//   not 6543 transaction-pooled mode).
// Phase 3: DATABASE_URL points at the local Postgres Docker
//   instance on 192.168.1.160.
// ============================================================

import { Kysely, PostgresDialect, type LogEvent } from 'kysely';
import { Pool, types as pgTypes } from 'pg';
import type { Database } from './schema';

// ── TIMESTAMP/TIMESTAMPTZ → ISO string globally ──────────────
// pg-node's default parser converts TIMESTAMPTZ (OID 1184) and
// TIMESTAMP (OID 1114) into JS Date objects, but the kysely schema
// types declare those columns as `Timestamp = string`. The mismatch
// bit us repeatedly: code that trusted the type and called
// `.slice()`, `String()` (in a kysely WHERE), or did string-equality
// against an ISO literal crashed at runtime against the actual Date
// shape. Most recently 2026-05-19 in AdminPanel (three call sites
// in one file, three sequential whack-a-mole fixes).
//
// Fix at the source: override the parsers to return ISO-8601 strings
// so the runtime shape matches the declared type everywhere. Code
// that needs a Date object continues to use `new Date(value)` — that
// constructor accepts ISO strings and works identically.
//
// Module-level side effect runs once at first import; the global
// `pgTypes` registry is shared by every Pool in this process.
pgTypes.setTypeParser(1184, (val: string | null) =>
  val == null ? null : new Date(val).toISOString(),
);
pgTypes.setTypeParser(1114, (val: string | null) =>
  val == null ? null : new Date(val).toISOString(),
);
// DATE (OID 1082) — same alignment problem as TIMESTAMPTZ. Default
// pg-node behavior returns a Date object midnight-UTC; kysely schema
// declares DATE columns as `string` (YYYY-MM-DD). Mismatch bit the
// /predictions/runs/[id]/email path 2026-06-30: emailPredictionsRun
// passed run.stat_as_of_date to escapeHtml which calls .replace()
// on it → "e.replace is not a function". pg-node delivers DATE
// values in YYYY-MM-DD format already; just pass them through.
pgTypes.setTypeParser(1082, (val: string | null) => val);

// ── Lazy-init real client ────────────────────────────────────

let _db: Kysely<Database> | null = null;
let _pool: Pool | null = null;

function getRealDb(): Kysely<Database> {
  if (_db) return _db;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'Database client requested before DATABASE_URL was configured. ' +
      'Set DATABASE_URL in .env.local — for Supabase Cloud, copy the ' +
      'pg connection string from Project Settings → Database. ' +
      'For local Phase-3 Postgres, point at the Docker instance.',
    );
  }

  _pool = new Pool({
    connectionString: url,
    // Modest pool — Next.js spawns multiple workers. 8 conns/worker is
    // a reasonable floor; bump if a sync run starves UI requests.
    max: 8,
    // ssl is required by Supabase Cloud's pooler; harmless for local.
    ssl: url.includes('supabase.co')
      ? { rejectUnauthorized: false }
      : undefined,
  });

  _db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: _pool }),
    log: (event: LogEvent) => {
      if (event.level === 'error') {
        // Surface query errors with the SQL — invaluable for debugging.
        console.error(
          `[db] query failed: ${event.error}\n  sql: ${event.query.sql}`,
        );
      }
    },
  });

  return _db;
}

/**
 * Lazily-initialized kysely instance. Use directly:
 *   `await db.selectFrom('leagues').selectAll().execute()`.
 *
 * The Proxy preserves the chained-builder API at every call site
 * without forcing every route to construct the client.
 */
export const db = new Proxy({} as Kysely<Database>, {
  get(_target, prop, _receiver) {
    const target = getRealDb();
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

/** Tear down the pool (used by tests / graceful shutdown). */
export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
  }
}

// Re-export schema types for convenience.
export type { Database } from './schema';
