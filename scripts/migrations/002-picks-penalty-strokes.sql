-- ============================================================
-- Migration 002 — Add penalty_strokes column to picks.
--
-- Drives the missed-deadline auto-assign feature (2026-06-04):
-- when a league member misses the pick deadline, the auto-assign
-- sweep generates a random unique lineup, locks it, and stamps
-- penalty_strokes = 2. The scoring function (computeLeagueResults
-- in src/lib/scoring.ts) reads this column and adds it to the
-- user's best-3-of-4 total at scoring time.
--
-- Schema delta:
--   - `picks.penalty_strokes INT NOT NULL DEFAULT 0` — added
--     strokes applied at scoring time. Reserved for future penalty
--     classes too (the current sweep is the only writer, but the
--     column is generic).
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/002-picks-penalty-strokes.sql
-- ============================================================

BEGIN;

-- 1. Add the column with a safe default so existing rows pick up 0.
ALTER TABLE picks
  ADD COLUMN IF NOT EXISTS penalty_strokes INT NOT NULL DEFAULT 0;

-- 2. Verify the column landed and every existing row reads 0
--    (the migration is conceptually a no-op for historical picks —
--    they predate this feature and don't get retroactively penalised).
DO $verify$
DECLARE
  bad_count INT;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM picks
  WHERE penalty_strokes IS NULL OR penalty_strokes < 0;

  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'Migration 002 verify failed: % picks have NULL or negative penalty_strokes',
      bad_count;
  END IF;
END;
$verify$;

COMMIT;
