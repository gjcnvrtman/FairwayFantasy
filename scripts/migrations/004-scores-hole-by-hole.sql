-- ============================================================
-- Migration 004 — Add per-hole stroke arrays to scores.
--
-- ESPN's scoreboard payload buries hole-by-hole strokes in
-- `c.linescores[round-1].linescores[hole-1].value`. We've been
-- reading the count of that inner array to derive `holes_played`
-- (migration 003) but throwing away the actual stroke values.
--
-- This migration persists them so the daily-scorecard email
-- (sync.ts:detectAndSendDailyScorecards, 2026-06-04) can render a
-- traditional 18-hole scorecard PDF without re-fetching ESPN
-- (and without losing the data once the next sync overwrites).
--
-- Shape: one INT[] column per round. Length is 0..18.
--   round_1_holes := [4, 3, 5, ...]  (strokes per hole)
--   round_2_holes := NULL            (round not yet played)
--
-- Why arrays not JSONB:
--   - Native pg INT[] is faster + smaller than JSON
--   - Kysely typing is cleaner: `number[] | null`
--   - We only need ordered ints, no key-value structure
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/004-scores-hole-by-hole.sql
-- ============================================================

BEGIN;

ALTER TABLE scores
  ADD COLUMN IF NOT EXISTS round_1_holes INT[],
  ADD COLUMN IF NOT EXISTS round_2_holes INT[],
  ADD COLUMN IF NOT EXISTS round_3_holes INT[],
  ADD COLUMN IF NOT EXISTS round_4_holes INT[];

-- Bounds: array length must be 0..18. NULL is allowed (round not
-- played / no data). Individual stroke values aren't constrained
-- — albatrosses (1) and high blow-up holes (10+) both happen.
ALTER TABLE scores
  DROP CONSTRAINT IF EXISTS scores_round_1_holes_len;
ALTER TABLE scores
  DROP CONSTRAINT IF EXISTS scores_round_2_holes_len;
ALTER TABLE scores
  DROP CONSTRAINT IF EXISTS scores_round_3_holes_len;
ALTER TABLE scores
  DROP CONSTRAINT IF EXISTS scores_round_4_holes_len;

ALTER TABLE scores
  ADD CONSTRAINT scores_round_1_holes_len
    CHECK (round_1_holes IS NULL OR array_length(round_1_holes, 1) IS NULL OR array_length(round_1_holes, 1) <= 18);
ALTER TABLE scores
  ADD CONSTRAINT scores_round_2_holes_len
    CHECK (round_2_holes IS NULL OR array_length(round_2_holes, 1) IS NULL OR array_length(round_2_holes, 1) <= 18);
ALTER TABLE scores
  ADD CONSTRAINT scores_round_3_holes_len
    CHECK (round_3_holes IS NULL OR array_length(round_3_holes, 1) IS NULL OR array_length(round_3_holes, 1) <= 18);
ALTER TABLE scores
  ADD CONSTRAINT scores_round_4_holes_len
    CHECK (round_4_holes IS NULL OR array_length(round_4_holes, 1) IS NULL OR array_length(round_4_holes, 1) <= 18);

-- Verify: columns exist, constraints exist, existing rows are NULL
-- (no backfill — we don't have historical hole-by-hole data).
DO $verify$
DECLARE
  col_count  INT;
  cons_count INT;
BEGIN
  SELECT COUNT(*) INTO col_count
  FROM information_schema.columns
  WHERE table_name='scores'
    AND column_name IN ('round_1_holes','round_2_holes','round_3_holes','round_4_holes');
  IF col_count != 4 THEN
    RAISE EXCEPTION 'Migration 004 verify failed: expected 4 round_N_holes columns, found %', col_count;
  END IF;

  SELECT COUNT(*) INTO cons_count
  FROM pg_constraint
  WHERE conname IN ('scores_round_1_holes_len','scores_round_2_holes_len',
                    'scores_round_3_holes_len','scores_round_4_holes_len');
  IF cons_count != 4 THEN
    RAISE EXCEPTION 'Migration 004 verify failed: expected 4 length constraints, found %', cons_count;
  END IF;
END;
$verify$;

COMMIT;
