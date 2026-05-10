#!/usr/bin/env tsx
/* ============================================================
 * SEED USER — create a profile + auth_credentials row directly,
 * skipping the Supabase migration. Used for "start fresh" deploys
 * where you don't care about preserving Supabase Cloud data.
 *
 * Idempotent — safe to run multiple times. Re-running with the same
 * email + a different password effectively resets that user's
 * password.
 *
 * USAGE
 *   DATABASE_URL='postgresql://fairway:HEXPASS@127.0.0.1:5434/fairway' \
 *   SEED_EMAIL='greg@example.com' \
 *   SEED_NAME='Greg' \
 *   SEED_PASSWORD='your-strong-password-here' \
 *     npx tsx scripts/seed-user.ts
 *
 * Then sign in at /auth/signin with that email + password.
 * ============================================================ */

import { Pool } from 'pg';
import bcrypt from 'bcryptjs';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`FATAL: ${name} env var is required.`);
    process.exit(1);
  }
  return v;
}

const DATABASE_URL  = requireEnv('DATABASE_URL');
const email         = requireEnv('SEED_EMAIL').trim().toLowerCase();
const display_name  = requireEnv('SEED_NAME').trim();
const password      = requireEnv('SEED_PASSWORD');

if (password.length < 8) {
  console.error('FATAL: SEED_PASSWORD must be at least 8 characters.');
  process.exit(1);
}

const BCRYPT_COST = 10;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('supabase.co') ? { rejectUnauthorized: false } : undefined,
  max: 2,
});

async function main() {
  console.log(`\n=== seed-user ===`);
  console.log(`DATABASE_URL: ${DATABASE_URL.replace(/:([^:@]+)@/, ':***@')}`);
  console.log(`email:        ${email}`);
  console.log(`display_name: ${display_name}\n`);

  const password_hash = await bcrypt.hash(password, BCRYPT_COST);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Upsert profile
    const profileResult = await client.query<{ id: string; created: boolean }>(
      `WITH up AS (
         INSERT INTO profiles (email, display_name)
         VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id, (xmax = 0) AS created
       )
       SELECT id::text, created FROM up`,
      [email, display_name],
    );
    const { id: userId, created } = profileResult.rows[0];
    console.log(`▸ profile ${created ? 'created' : 'already existed; display_name updated'} → id=${userId}`);

    // 2. Upsert credentials. email_verified=true since you're seeding
    //    yourself directly — no need to click a verify link.
    await client.query(
      `INSERT INTO auth_credentials
         (user_id, password_hash, email_verified, updated_at)
       VALUES ($1, $2, TRUE, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         email_verified = TRUE,
         updated_at     = NOW()`,
      [userId, password_hash],
    );
    console.log(`▸ auth_credentials upserted (bcrypt hash, email_verified=true)`);

    await client.query('COMMIT');

    console.log(`\n✓ done. sign in at /auth/signin with:`);
    console.log(`  email:    ${email}`);
    console.log(`  password: <the SEED_PASSWORD you provided>\n`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
