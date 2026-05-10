#!/usr/bin/env tsx
/* ============================================================
 * PRE-FLIGHT CHECK — run BEFORE migrate-from-supabase.ts
 *
 * Catches the most common Phase-5 cutover failures early:
 *   - SOURCE_DATABASE_URL is unreachable / bad creds
 *   - DATABASE_URL is unreachable
 *   - target schema isn't applied (auth_credentials missing → migrate
 *     would crash mid-stream)
 *   - target already has data (would silently no-op due to ON CONFLICT)
 *   - source counts make sense (you didn't accidentally point at the
 *     WRONG cloud project — sanity check)
 *
 * USAGE
 *   SOURCE_DATABASE_URL='postgresql://postgres:CLOUDPASS@db.xxx.supabase.co:5432/postgres' \
 *   DATABASE_URL='postgresql://fairway:LOCALPASS@127.0.0.1:5432/fairway' \
 *     npx tsx scripts/preflight-check.ts
 *
 * Exit code 0 = good to migrate. Non-zero = fix the surfaced issue first.
 * ============================================================ */

import { Pool } from 'pg';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`FATAL: ${name} env var is required.`);
    process.exit(1);
  }
  return v;
}

const SOURCE_URL = requireEnv('SOURCE_DATABASE_URL');
const TARGET_URL = requireEnv('DATABASE_URL');

if (SOURCE_URL === TARGET_URL) {
  console.error('FATAL: SOURCE_DATABASE_URL and DATABASE_URL are identical.');
  process.exit(1);
}

const source = new Pool({
  connectionString: SOURCE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});
const target = new Pool({
  connectionString: TARGET_URL,
  max: 2,
});

interface Check {
  name: string;
  run: () => Promise<{ ok: boolean; detail: string }>;
}

const APP_TABLES = [
  'profiles', 'auth_credentials', 'leagues', 'league_members',
  'tournaments', 'golfers', 'picks', 'scores',
  'fantasy_results', 'season_standings',
  'reminder_preferences', 'reminder_log',
] as const;

const checks: Check[] = [
  {
    name: 'source DB reachable',
    async run() {
      try {
        const r = await source.query('SELECT current_database() AS db');
        return { ok: true, detail: `connected to ${r.rows[0].db}` };
      } catch (err) {
        return { ok: false, detail: String(err) };
      }
    },
  },
  {
    name: 'source has Supabase auth schema',
    async run() {
      try {
        const r = await source.query(
          `SELECT 1 FROM information_schema.tables
           WHERE table_schema='auth' AND table_name='users'`,
        );
        return r.rowCount
          ? { ok: true, detail: 'auth.users exists' }
          : { ok: false, detail: 'auth.users not found — is this really a Supabase project?' };
      } catch (err) {
        return { ok: false, detail: String(err) };
      }
    },
  },
  {
    name: 'source has expected app tables',
    async run() {
      // Check the core tables exist; reminder_* may be absent if P9
      // wasn't applied to the cloud — that's allowed, the migration
      // skips gracefully.
      const required = ['profiles', 'leagues', 'league_members', 'tournaments',
                        'golfers', 'picks', 'scores', 'fantasy_results',
                        'season_standings'];
      const missing: string[] = [];
      for (const t of required) {
        const r = await source.query(
          `SELECT 1 FROM information_schema.tables
           WHERE table_schema='public' AND table_name=$1`,
          [t],
        );
        if (!r.rowCount) missing.push(t);
      }
      return missing.length
        ? { ok: false, detail: `missing in source: ${missing.join(', ')}` }
        : { ok: true, detail: `all ${required.length} required tables present` };
    },
  },
  {
    name: 'source row counts are sane',
    async run() {
      // Quick sanity check — if profiles count is 0, you're probably
      // pointed at the wrong project. Surface so you can stop early.
      const r = await source.query(`SELECT COUNT(*)::int AS c FROM public.profiles`);
      const n = r.rows[0].c as number;
      return n > 0
        ? { ok: true, detail: `${n} profiles in source` }
        : { ok: false, detail: 'source has 0 profiles — wrong project?' };
    },
  },
  {
    name: 'target DB reachable',
    async run() {
      try {
        const r = await target.query('SELECT current_database() AS db');
        return { ok: true, detail: `connected to ${r.rows[0].db}` };
      } catch (err) {
        return { ok: false, detail: String(err) };
      }
    },
  },
  {
    name: 'target schema applied',
    async run() {
      const missing: string[] = [];
      for (const t of APP_TABLES) {
        const r = await target.query(
          `SELECT 1 FROM information_schema.tables
           WHERE table_schema='public' AND table_name=$1`,
          [t],
        );
        if (!r.rowCount) missing.push(t);
      }
      return missing.length
        ? { ok: false, detail: `target missing tables: ${missing.join(', ')}` +
                                ` — did docker compose's init script run? ` +
                                `try \`docker compose logs postgres\``
          }
        : { ok: true, detail: `all ${APP_TABLES.length} expected tables present` };
    },
  },
  {
    name: 'target is empty (or accept ON CONFLICT no-op)',
    async run() {
      const counts: string[] = [];
      let total = 0;
      for (const t of APP_TABLES) {
        try {
          const r = await target.query(`SELECT COUNT(*)::int AS c FROM ${t}`);
          const n = r.rows[0].c as number;
          if (n > 0) {
            counts.push(`${t}=${n}`);
            total += n;
          }
        } catch {
          // table might not exist — already caught by previous check
        }
      }
      if (total === 0) return { ok: true, detail: 'target is empty' };
      return {
        ok: true,                                  // NOT a fatal error
        detail: `target already has rows (${counts.join(', ')}) — ` +
                'migration will skip duplicates via ON CONFLICT DO NOTHING. ' +
                'For a clean re-run: `docker compose down -v && docker compose up -d`',
      };
    },
  },
  {
    name: 'auth.users has password hashes',
    async run() {
      const r = await source.query(
        `SELECT COUNT(*)::int AS with_hash
         FROM auth.users
         WHERE encrypted_password IS NOT NULL AND encrypted_password <> ''`,
      );
      const n = r.rows[0].with_hash as number;
      return n > 0
        ? { ok: true, detail: `${n} users have password hashes (will migrate)` }
        : { ok: false, detail: 'no auth.users have hashes — wrong table?' };
    },
  },
];

async function main() {
  console.log('\n=== Fairway Fantasy migration pre-flight ===');
  console.log(`SOURCE: ${SOURCE_URL.replace(/:([^:@]+)@/, ':***@')}`);
  console.log(`TARGET: ${TARGET_URL.replace(/:([^:@]+)@/, ':***@')}\n`);

  let failures = 0;
  for (const check of checks) {
    process.stdout.write(`▸ ${check.name.padEnd(50)} `);
    const r = await check.run();
    console.log(`${r.ok ? '✓' : '✗'}  ${r.detail}`);
    if (!r.ok) failures++;
  }

  await source.end();
  await target.end();

  if (failures === 0) {
    console.log('\n✓ all preflight checks passed — safe to run migrate-from-supabase.ts\n');
    process.exit(0);
  }
  console.log(`\n✗ ${failures} check(s) failed — fix before running the migration\n`);
  process.exit(1);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
