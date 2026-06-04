-- ============================================================
-- Migration 003 — Add holes_played column to scores.
--
-- Surfaces ESPN's `status.thru` field (0-18 holes completed in the
-- current round) on the leaderboard. Today the normalizer in
-- src/lib/espn.ts defaults the whole `status` object to zeros when
-- the scoreboard fallback path is taken, and syncTournament in
-- src/lib/sync.ts ignores the field entirely. This column gives
-- us a place to persist it.
--
-- Nullable on purpose: NULL = "we don't know" (scoreboard fallback
-- path, pre-tee-off, etc.). 0 = "round started, no holes done yet".
-- 18 = "current round complete". The render layer distinguishes
-- NULL → em-dash from numeric values per Greg's display spec
-- (2026-06-04).
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/003-scores-holes-played.sql
-- ============================================================

BEGIN;

ALTER TABLE scores
  ADD COLUMN IF NOT EXISTS holes_played INT;

-- Bounds check: 0..18 inclusive. NULL is allowed.
ALTER TABLE scores
  DROP CONSTRAINT IF EXISTS scores_holes_played_range;
ALTER TABLE scores
  ADD CONSTRAINT scores_holes_played_range
  CHECK (holes_played IS NULL OR (holes_played >= 0 AND holes_played <= 18));

-- Verify the column landed nullable + the constraint exists.
DO $verify$
DECLARE
  col_count   INT;
  cons_count  INT;
BEGIN
  SELECT COUNT(*) INTO col_count
  FROM information_schema.columns
  WHERE table_name='scores' AND column_name='holes_played';
  IF col_count != 1 THEN
    RAISE EXCEPTION 'Migration 003 verify failed: scores.holes_played did not land';
  END IF;

  SELECT COUNT(*) INTO cons_count
  FROM pg_constraint
  WHERE conname='scores_holes_played_range';
  IF cons_count != 1 THEN
    RAISE EXCEPTION 'Migration 003 verify failed: scores_holes_played_range constraint missing';
  END IF;
END;
$verify$;

COMMIT;
