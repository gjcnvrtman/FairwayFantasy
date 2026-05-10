#!/usr/bin/env tsx
/* ============================================================
 * POST-MIGRATION SMOKE TEST — run AFTER migrate-from-supabase.ts
 * but BEFORE flipping prod's DATABASE_URL.
 *
 * Validates that the new local DB has clean, consistent data:
 *   - Every profile has matching auth_credentials (so existing
 *     users can sign in).
 *   - No orphan FKs (every league_members.league_id resolves; same
 *     for picks, fantasy_results, scores).
 *   - Source counts ≈ target counts (no silent row drops).
 *   - At least one bcrypt hash looks like a valid bcrypt hash
 *     (catches "you copied the wrong column" mistakes).
 *
 * USAGE
 *   SOURCE_DATABASE_URL='...' DATABASE_URL='...' \
 *     npx tsx scripts/post-migration-check.ts
 *
 * Exit code 0 = data looks good, OK to flip DATABASE_URL on prod.
 * Non-zero = investigate before cutover.
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

const source = new Pool({
  connectionString: SOURCE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});
const target = new Pool({ connectionString: TARGET_URL, max: 2 });

// Tables that should round-trip 1:1. Reminder tables are skipped if
// the source didn't have them (P9 may not have hit cloud yet).
const ROUND_TRIP = [
  'profiles', 'leagues', 'league_members', 'tournaments',
  'golfers', 'picks', 'scores',
  'fantasy_results', 'season_standings',
] as const;

interface Result { ok: boolean; detail: string; warn?: boolean }

async function checkRowCounts(): Promise<Result[]> {
  const out: Result[] = [];
  for (const t of ROUND_TRIP) {
    try {
      const [s, d] = await Promise.all([
        source.query(`SELECT COUNT(*)::int AS c FROM public.${t}`),
        target.query(`SELECT COUNT(*)::int AS c FROM ${t}`),
      ]);
      const sc = s.rows[0].c, dc = d.rows[0].c;
      if (sc === dc) {
        out.push({ ok: true,  detail: `${t}: ${sc} → ${dc} (match)` });
      } else if (dc < sc) {
        out.push({ ok: false, detail: `${t}: ${sc} → ${dc} (LOST ${sc - dc} rows)` });
      } else {
        out.push({
          ok: true, warn: true,
          detail: `${t}: ${sc} → ${dc} (target has ${dc - sc} extra — pre-existing rows?)`,
        });
      }
    } catch (err) {
      out.push({ ok: false, detail: `${t}: ${String(err).slice(0, 100)}` });
    }
  }
  return out;
}

async function checkAuthCoverage(): Promise<Result> {
  const r = await target.query(
    `SELECT
       (SELECT COUNT(*) FROM profiles)         ::int AS profiles,
       (SELECT COUNT(*) FROM auth_credentials) ::int AS creds,
       (SELECT COUNT(*) FROM profiles p
          LEFT JOIN auth_credentials c ON c.user_id = p.id
          WHERE c.user_id IS NULL)             ::int AS missing`,
  );
  const { profiles, creds, missing } = r.rows[0];
  if (missing === 0) {
    return {
      ok: true,
      detail: `every profile has credentials (${profiles} profiles, ${creds} creds)`,
    };
  }
  return {
    ok: false,
    detail: `${missing} profiles have NO auth_credentials row — those users can't sign in`,
  };
}

async function checkBcryptShape(): Promise<Result> {
  const r = await target.query(
    `SELECT password_hash FROM auth_credentials LIMIT 1`,
  );
  if (r.rowCount === 0) {
    return { ok: false, detail: 'no auth_credentials rows at all' };
  }
  const h = r.rows[0].password_hash as string;
  // bcrypt: starts with $2a$, $2b$, or $2y$, total 60 chars.
  const looksRight = /^\$2[aby]\$\d{2}\$/.test(h) && h.length === 60;
  return looksRight
    ? { ok: true,  detail: `password_hash format OK (${h.slice(0, 7)}…, len=${h.length})` }
    : { ok: false, detail: `password_hash doesn't look like bcrypt: "${h.slice(0, 30)}…"` };
}

async function checkOrphanFKs(): Promise<Result[]> {
  const queries: Array<{ name: string; sql: string }> = [
    {
      name: 'league_members → leagues',
      sql:  `SELECT COUNT(*)::int AS c FROM league_members lm
             LEFT JOIN leagues l ON l.id = lm.league_id WHERE l.id IS NULL`,
    },
    {
      name: 'league_members → profiles',
      sql:  `SELECT COUNT(*)::int AS c FROM league_members lm
             LEFT JOIN profiles p ON p.id = lm.user_id WHERE p.id IS NULL`,
    },
    {
      name: 'picks → leagues',
      sql:  `SELECT COUNT(*)::int AS c FROM picks pk
             LEFT JOIN leagues l ON l.id = pk.league_id WHERE l.id IS NULL`,
    },
    {
      name: 'picks → tournaments',
      sql:  `SELECT COUNT(*)::int AS c FROM picks pk
             LEFT JOIN tournaments t ON t.id = pk.tournament_id WHERE t.id IS NULL`,
    },
    {
      name: 'picks → profiles',
      sql:  `SELECT COUNT(*)::int AS c FROM picks pk
             LEFT JOIN profiles p ON p.id = pk.user_id WHERE p.id IS NULL`,
    },
    {
      name: 'scores → tournaments',
      sql:  `SELECT COUNT(*)::int AS c FROM scores s
             LEFT JOIN tournaments t ON t.id = s.tournament_id WHERE t.id IS NULL`,
    },
    {
      name: 'scores → golfers',
      sql:  `SELECT COUNT(*)::int AS c FROM scores s
             LEFT JOIN golfers g ON g.id = s.golfer_id WHERE g.id IS NULL`,
    },
    {
      name: 'fantasy_results → leagues',
      sql:  `SELECT COUNT(*)::int AS c FROM fantasy_results fr
             LEFT JOIN leagues l ON l.id = fr.league_id WHERE l.id IS NULL`,
    },
    {
      name: 'fantasy_results → profiles',
      sql:  `SELECT COUNT(*)::int AS c FROM fantasy_results fr
             LEFT JOIN profiles p ON p.id = fr.user_id WHERE p.id IS NULL`,
    },
  ];

  const out: Result[] = [];
  for (const q of queries) {
    const r = await target.query(q.sql);
    const n = r.rows[0].c as number;
    out.push(
      n === 0
        ? { ok: true,  detail: `${q.name}: clean` }
        : { ok: false, detail: `${q.name}: ${n} ORPHAN rows` },
    );
  }
  return out;
}

async function main() {
  console.log('\n=== Fairway Fantasy post-migration smoke test ===');
  console.log(`SOURCE: ${SOURCE_URL.replace(/:([^:@]+)@/, ':***@')}`);
  console.log(`TARGET: ${TARGET_URL.replace(/:([^:@]+)@/, ':***@')}\n`);

  let failures = 0;
  let warnings = 0;

  const sections: Array<{ name: string; results: Result[] }> = [
    { name: 'row count parity',  results: await checkRowCounts() },
    { name: 'auth coverage',     results: [await checkAuthCoverage()] },
    { name: 'bcrypt hash shape', results: [await checkBcryptShape()] },
    { name: 'orphan FK check',   results: await checkOrphanFKs() },
  ];

  for (const section of sections) {
    console.log(`── ${section.name}`);
    for (const r of section.results) {
      const sigil = r.ok ? (r.warn ? '!' : '✓') : '✗';
      console.log(`  ${sigil}  ${r.detail}`);
      if (!r.ok) failures++;
      else if (r.warn) warnings++;
    }
    console.log();
  }

  await source.end();
  await target.end();

  if (failures === 0 && warnings === 0) {
    console.log('✓ all checks passed — safe to flip DATABASE_URL on prod\n');
    process.exit(0);
  }
  if (failures === 0) {
    console.log(`! ${warnings} warning(s) but no failures — review and proceed if expected\n`);
    process.exit(0);
  }
  console.log(`✗ ${failures} failure(s) — DO NOT flip DATABASE_URL until fixed\n`);
  process.exit(1);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
