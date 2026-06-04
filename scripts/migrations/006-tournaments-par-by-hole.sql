-- ============================================================
-- Migration 006 — Add par_by_hole to tournaments.
--
-- Drives the par row on the daily-scorecard PDF (Greg's follow-up
-- 2026-06-04). Par is course-wide — every golfer who plays hole N
-- in any round has the same par for that hole — so it lives on the
-- tournament, not the score.
--
-- We derive par from ESPN's per-hole scoreType.displayValue ("E",
-- "-1", "+1") + strokes value:  par = strokes − relative_to_par.
-- Computed at sync time across the field; the first golfer's data
-- on hole N wins (all golfers must agree, and they do).
--
-- Shape: INT[] of length 0..18. NULL = "not yet derived". An entry
-- can also be NULL (sparse array) if no golfer has played that
-- hole yet.
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/006-tournaments-par-by-hole.sql
-- ============================================================

BEGIN;

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS par_by_hole INT[];

ALTER TABLE tournaments
  DROP CONSTRAINT IF EXISTS tournaments_par_by_hole_len;
ALTER TABLE tournaments
  ADD CONSTRAINT tournaments_par_by_hole_len
  CHECK (par_by_hole IS NULL OR array_length(par_by_hole, 1) IS NULL OR array_length(par_by_hole, 1) <= 18);

DO $verify$
DECLARE c INT;
BEGIN
  SELECT COUNT(*) INTO c FROM information_schema.columns
   WHERE table_name='tournaments' AND column_name='par_by_hole';
  IF c != 1 THEN RAISE EXCEPTION 'Migration 006 verify failed: par_by_hole column missing'; END IF;
END;
$verify$;

COMMIT;
