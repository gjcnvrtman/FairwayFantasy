-- ============================================================
-- Migration 003 — pick_deadline commissioner override (P1).
--
-- The rankings sync sets pick_deadline = start_date - 1h, but ESPN's
-- start_date can be 6+ hours off the real first tee time (tournament
-- "day" starts before the first group hits the course). Commissioners
-- need a way to override per tournament when the auto-computed
-- deadline is wrong.
--
-- This migration adds a nullable override column on tournaments.
-- The effective deadline is COALESCE(pick_deadline_override, pick_deadline).
-- Override is independent of pick_deadline, so the rankings sync can
-- continue refreshing pick_deadline without clobbering the override.
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/003-pick-deadline-override.sql
-- ============================================================

BEGIN;

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS pick_deadline_override TIMESTAMPTZ;

COMMENT ON COLUMN tournaments.pick_deadline_override IS
  'Commissioner-set pick deadline override. When non-null, takes precedence over pick_deadline (auto-computed from start_date). NULL = use the default.';

COMMIT;
