#!/usr/bin/env tsx
/* ============================================================
 * MIGRATE FROM SUPABASE — one-shot data migration script.
 *
 * Used at Phase-5 cutover: pulls every Fairway-owned table from
 * the Supabase Cloud Postgres + bcrypt password hashes from the
 * `auth.users` table, and writes them into a freshly-initialized
 * local Postgres.
 *
 * USAGE
 *   # Dry-run first — counts rows, doesn't write anything:
 *   SOURCE_DATABASE_URL='postgresql://postgres:...@db.xxx.supabase.co:5432/postgres' \
 *   DATABASE_URL='postgresql://fairway:...@127.0.0.1:5432/fairway' \
 *   npx tsx scripts/migrate-from-supabase.ts --dry-run
 *
 *   # Real run:
 *   npx tsx scripts/migrate-from-supabase.ts
 *
 * IDEMPOTENCY
 *   Every insert uses ON CONFLICT DO NOTHING. Re-running is safe
 *   in the sense that it won't error, but it WILL skip rows that
 *   already exist (won't update them). For a clean re-run, drop
 *   and recreate the local DB:
 *     docker compose down -v && docker compose up -d
 *
 * SAFETY
 *   The target DB must be empty (or you accept the no-op-on-conflict
 *   behavior). Source connection is read-only — script never writes
 *   to Supabase.
 * ============================================================ */

import { Pool } from 'pg';

const DRY_RUN = process.argv.includes('--dry-run');

// ── Connection setup ────────────────────────────────────────

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

// Source = Supabase Cloud (SSL required by their pooler).
// Target = local Postgres (loopback, no SSL).
const source = new Pool({
  connectionString: SOURCE_URL,
  ssl: { rejectUnauthorized: false },
  max: 4,
});
const target = new Pool({
  connectionString: TARGET_URL,
  max: 4,
});

// ── Migration plan ──────────────────────────────────────────
// Tables in dependency order. Each entry describes:
//   - the source query (SELECT)
//   - the target insert (INSERT ... ON CONFLICT DO NOTHING)
//
// We don't use generic table-copy because column lists may differ
// (e.g., Supabase's auth.users → our auth_credentials shape).

interface CopyStep {
  name: string;
  /** Returns rows to insert. */
  pull: () => Promise<Record<string, unknown>[]>;
  /** Inserts a single row. */
  push: (row: Record<string, unknown>) => Promise<void>;
}

const steps: CopyStep[] = [
  // ── 1. profiles ─────────────────────────────────────────
  {
    name: 'profiles',
    async pull() {
      const r = await source.query(
        `SELECT id, display_name, email, created_at FROM public.profiles`,
      );
      return r.rows;
    },
    async push(row) {
      if (DRY_RUN) return;
      await target.query(
        `INSERT INTO profiles (id, display_name, email, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [row.id, row.display_name, row.email, row.created_at],
      );
    },
  },

  // ── 2. auth_credentials (from Supabase auth.users → bcrypt hashes) ─
  // Supabase stores the hash in auth.users.encrypted_password (bcrypt).
  // We map it 1:1 into auth_credentials. Existing users keep their
  // current passwords, no reset email required.
  {
    name: 'auth_credentials (from auth.users)',
    async pull() {
      const r = await source.query(
        `SELECT u.id              AS user_id,
                u.encrypted_password AS password_hash,
                u.email_confirmed_at IS NOT NULL AS email_verified,
                u.last_sign_in_at AS last_login_at,
                u.created_at      AS created_at,
                u.updated_at      AS updated_at
         FROM   auth.users u
         WHERE  u.encrypted_password IS NOT NULL
           AND  EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id)`,
      );
      return r.rows;
    },
    async push(row) {
      if (DRY_RUN) return;
      await target.query(
        `INSERT INTO auth_credentials
           (user_id, password_hash, email_verified,
            last_login_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id) DO NOTHING`,
        [
          row.user_id, row.password_hash, row.email_verified,
          row.last_login_at, row.created_at, row.updated_at,
        ],
      );
    },
  },

  // ── 3. golfers ──────────────────────────────────────────
  // is_dark_horse is GENERATED ALWAYS — we don't insert it.
  {
    name: 'golfers',
    async pull() {
      const r = await source.query(
        `SELECT id, espn_id, datagolf_id, name, owgr_rank,
                headshot_url, country, updated_at
         FROM public.golfers`,
      );
      return r.rows;
    },
    async push(row) {
      if (DRY_RUN) return;
      await target.query(
        `INSERT INTO golfers
           (id, espn_id, datagolf_id, name, owgr_rank,
            headshot_url, country, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          row.id, row.espn_id, row.datagolf_id, row.name, row.owgr_rank,
          row.headshot_url, row.country, row.updated_at,
        ],
      );
    },
  },

  // ── 4. tournaments ──────────────────────────────────────
  {
    name: 'tournaments',
    async pull() {
      const r = await source.query(
        `SELECT id, espn_event_id, name, type, season,
                start_date, end_date, pick_deadline, cut_score,
                status, course_name, created_at
         FROM public.tournaments`,
      );
      return r.rows;
    },
    async push(row) {
      if (DRY_RUN) return;
      await target.query(
        `INSERT INTO tournaments
           (id, espn_event_id, name, type, season,
            start_date, end_date, pick_deadline, cut_score,
            status, course_name, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO NOTHING`,
        [
          row.id, row.espn_event_id, row.name, row.type, row.season,
          row.start_date, row.end_date, row.pick_deadline, row.cut_score,
          row.status, row.course_name, row.created_at,
        ],
      );
    },
  },

  // ── 5. leagues ──────────────────────────────────────────
  {
    name: 'leagues',
    async pull() {
      const r = await source.query(
        `SELECT id, name, slug, invite_code, commissioner_id,
                max_players, created_at
         FROM public.leagues`,
      );
      return r.rows;
    },
    async push(row) {
      if (DRY_RUN) return;
      await target.query(
        `INSERT INTO leagues
           (id, name, slug, invite_code, commissioner_id,
            max_players, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO NOTHING`,
        [
          row.id, row.name, row.slug, row.invite_code, row.commissioner_id,
          row.max_players, row.created_at,
        ],
      );
    },
  },

  // ── 6. league_members ───────────────────────────────────
  {
    name: 'league_members',
    async pull() {
      const r = await source.query(
        `SELECT id, league_id, user_id, role, joined_at FROM public.league_members`,
      );
      return r.rows;
    },
    async push(row) {
      if (DRY_RUN) return;
      await target.query(
        `INSERT INTO league_members (id, league_id, user_id, role, joined_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [row.id, row.league_id, row.user_id, row.role, row.joined_at],
      );
    },
  },

  // ── 7. picks ────────────────────────────────────────────
  {
    name: 'picks',
    async pull() {
      const r = await source.query(
        `SELECT id, league_id, tournament_id, user_id,
                golfer_1_id, golfer_2_id, golfer_3_id, golfer_4_id,
                is_locked, submitted_at
         FROM public.picks`,
      );
      return r.rows;
    },
    async push(row) {
      if (DRY_RUN) return;
      await target.query(
        `INSERT INTO picks
           (id, league_id, tournament_id, user_id,
            golfer_1_id, golfer_2_id, golfer_3_id, golfer_4_id,
            is_locked, submitted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO NOTHING`,
        [
          row.id, row.league_id, row.tournament_id, row.user_id,
          row.golfer_1_id, row.golfer_2_id, row.golfer_3_id, row.golfer_4_id,
          row.is_locked, row.submitted_at,
        ],
      );
    },
  },

  // ── 8. scores ───────────────────────────────────────────
  {
    name: 'scores',
    async pull() {
      const r = await source.query(
        `SELECT id, tournament_id, golfer_id, espn_golfer_id,
                round_1, round_2, round_3, round_4,
                total_strokes, score_to_par, position,
                status, fantasy_score, was_replaced, replaced_by_golfer_id,
                last_synced
         FROM public.scores`,
      );
      return r.rows;
    },
    async push(row) {
      if (DRY_RUN) return;
      await target.query(
        `INSERT INTO scores
           (id, tournament_id, golfer_id, espn_golfer_id,
            round_1, round_2, round_3, round_4,
            total_strokes, score_to_par, position,
            status, fantasy_score, was_replaced, replaced_by_golfer_id,
            last_synced)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (id) DO NOTHING`,
        [
          row.id, row.tournament_id, row.golfer_id, row.espn_golfer_id,
          row.round_1, row.round_2, row.round_3, row.round_4,
          row.total_strokes, row.score_to_par, row.position,
          row.status, row.fantasy_score, row.was_replaced, row.replaced_by_golfer_id,
          row.last_synced,
        ],
      );
    },
  },

  // ── 9. fantasy_results ──────────────────────────────────
  {
    name: 'fantasy_results',
    async pull() {
      const r = await source.query(
        `SELECT id, league_id, tournament_id, user_id,
                golfer_1_score, golfer_2_score, golfer_3_score, golfer_4_score,
                counting_golfers, total_score, rank, updated_at
         FROM public.fantasy_results`,
      );
      return r.rows;
    },
    async push(row) {
      if (DRY_RUN) return;
      await target.query(
        `INSERT INTO fantasy_results
           (id, league_id, tournament_id, user_id,
            golfer_1_score, golfer_2_score, golfer_3_score, golfer_4_score,
            counting_golfers, total_score, rank, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO NOTHING`,
        [
          row.id, row.league_id, row.tournament_id, row.user_id,
          row.golfer_1_score, row.golfer_2_score, row.golfer_3_score, row.golfer_4_score,
          row.counting_golfers, row.total_score, row.rank, row.updated_at,
        ],
      );
    },
  },

  // ── 10. season_standings ────────────────────────────────
  {
    name: 'season_standings',
    async pull() {
      const r = await source.query(
        `SELECT id, league_id, user_id, season,
                total_score, tournaments_played, best_finish, rank, updated_at
         FROM public.season_standings`,
      );
      return r.rows;
    },
    async push(row) {
      if (DRY_RUN) return;
      await target.query(
        `INSERT INTO season_standings
           (id, league_id, user_id, season,
            total_score, tournaments_played, best_finish, rank, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO NOTHING`,
        [
          row.id, row.league_id, row.user_id, row.season,
          row.total_score, row.tournaments_played, row.best_finish, row.rank,
          row.updated_at,
        ],
      );
    },
  },

  // ── 11. reminder_preferences ────────────────────────────
  // Populated only if user opted into reminders pre-cutover.
  {
    name: 'reminder_preferences',
    async pull() {
      // Source may not have this table if Phase-9 hasn't been
      // applied to the live Cloud DB yet — handle absence gracefully.
      try {
        const r = await source.query(
          `SELECT user_id, email_enabled, sms_enabled, push_enabled,
                  hours_before, email_addr, phone_e164, push_token, updated_at
           FROM public.reminder_preferences`,
        );
        return r.rows;
      } catch (err) {
        console.log(`  (skipping — source table missing: ${err instanceof Error ? err.message : err})`);
        return [];
      }
    },
    async push(row) {
      if (DRY_RUN) return;
      await target.query(
        `INSERT INTO reminder_preferences
           (user_id, email_enabled, sms_enabled, push_enabled,
            hours_before, email_addr, phone_e164, push_token, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (user_id) DO NOTHING`,
        [
          row.user_id, row.email_enabled, row.sms_enabled, row.push_enabled,
          row.hours_before, row.email_addr, row.phone_e164, row.push_token,
          row.updated_at,
        ],
      );
    },
  },

  // ── 12. reminder_log ────────────────────────────────────
  {
    name: 'reminder_log',
    async pull() {
      try {
        const r = await source.query(
          `SELECT id, user_id, league_id, tournament_id,
                  channel, status, error_message, sent_at
           FROM public.reminder_log`,
        );
        return r.rows;
      } catch (err) {
        console.log(`  (skipping — source table missing: ${err instanceof Error ? err.message : err})`);
        return [];
      }
    },
    async push(row) {
      if (DRY_RUN) return;
      await target.query(
        `INSERT INTO reminder_log
           (id, user_id, league_id, tournament_id,
            channel, status, error_message, sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [
          row.id, row.user_id, row.league_id, row.tournament_id,
          row.channel, row.status, row.error_message, row.sent_at,
        ],
      );
    },
  },
];

// ── Run ──────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Fairway Fantasy migration${DRY_RUN ? ' (DRY RUN)' : ''} ===`);
  console.log(`SOURCE: ${SOURCE_URL.replace(/:([^:@]+)@/, ':***@')}`);
  console.log(`TARGET: ${TARGET_URL.replace(/:([^:@]+)@/, ':***@')}\n`);

  // Sanity: target should be empty(ish). We don't enforce — caller decides.
  const probe = await target.query(`SELECT COUNT(*)::int AS c FROM profiles`);
  if (probe.rows[0].c > 0) {
    console.log(`⚠️  Target already has ${probe.rows[0].c} profile rows. ON CONFLICT will skip duplicates.`);
  }

  const totals: Record<string, number> = {};
  for (const step of steps) {
    process.stdout.write(`▸ ${step.name}: `);
    const rows = await step.pull();
    let written = 0;
    for (const row of rows) {
      try {
        await step.push(row);
        written++;
      } catch (err) {
        console.error(`\n  ✗ insert error on row ${JSON.stringify(row).slice(0, 80)}…\n    ${err}`);
      }
    }
    totals[step.name] = written;
    console.log(`${written} / ${rows.length}${DRY_RUN ? ' (dry-run; no writes)' : ''}`);
  }

  console.log('\n=== summary ===');
  for (const [k, v] of Object.entries(totals)) {
    console.log(`  ${k.padEnd(40)} ${v}`);
  }

  await source.end();
  await target.end();
  console.log(DRY_RUN ? '\n✓ dry-run complete' : '\n✓ migration complete');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
