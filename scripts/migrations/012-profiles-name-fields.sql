-- ============================================================
-- Migration 012 — profiles.first_name + profiles.last_name
--
-- Adds nullable name fields to the profiles table. Greg's call
-- 2026-06-12: signup now requires first + last name (collected
-- by /auth/signup), but existing users predate the column so we
-- leave the field NULLable. Leaderboard label prefers the real
-- name when present and falls back to email otherwise.
--
-- Admin (commissioner + co_commissioner) can edit any member's
-- name via /api/admin/member-name in case the user typos at
-- signup.
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/012-profiles-name-fields.sql
--
-- Rollback:
--   ALTER TABLE profiles
--     DROP COLUMN first_name,
--     DROP COLUMN last_name;
-- ============================================================

BEGIN;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name  TEXT;

-- Defensive trim to match the API-layer behaviour (the route stores
-- empty-string-after-trim as NULL). Idempotent on a freshly-added
-- column where every row's value is already NULL.
UPDATE profiles
   SET first_name = NULLIF(BTRIM(first_name), ''),
       last_name  = NULLIF(BTRIM(last_name),  '');

COMMIT;
