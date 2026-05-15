-- ============================================================
-- Migration 001 — DB-backed uniqueness for the four-golfer pick
-- (P0 #3.2). Closes the race window where two users submitting
-- identical foursomes concurrently both pass app-level validation
-- (`src/lib/scoring.ts:validatePick`) and both insert.
--
-- Schema delta:
--   - `picks.golfer_tuple_hash TEXT` — sorted concat of the 4 IDs,
--     maintained by a BEFORE INSERT/UPDATE trigger.
--   - Partial UNIQUE INDEX on (league_id, tournament_id, hash) that
--     only applies when all 4 golfer_N_id are non-null, so
--     in-progress/partial picks don't collide.
--
-- Applied to .150 production DB on 2026-05-15 (PGA Championship
-- weekend, 3 live picks, zero existing duplicates pre-migration).
--
-- Apply to a fresh DB:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/001-picks-foursome-hash.sql
-- ============================================================

BEGIN;

-- 1. New column (nullable for now — populated by trigger below)
ALTER TABLE picks
  ADD COLUMN IF NOT EXISTS golfer_tuple_hash TEXT;

-- 2. Backfill for any existing picks
UPDATE picks SET golfer_tuple_hash = (
  SELECT string_agg(g::text, '|' ORDER BY g)
  FROM unnest(ARRAY[golfer_1_id, golfer_2_id, golfer_3_id, golfer_4_id]) AS g
);

-- 3. Trigger function: recompute the hash on insert or when any of
--    the 4 golfer_N_id columns change.
CREATE OR REPLACE FUNCTION picks_compute_tuple_hash() RETURNS trigger AS $func$
BEGIN
  NEW.golfer_tuple_hash := (
    SELECT string_agg(g::text, '|' ORDER BY g)
    FROM unnest(ARRAY[NEW.golfer_1_id, NEW.golfer_2_id,
                      NEW.golfer_3_id, NEW.golfer_4_id]) AS g
  );
  RETURN NEW;
END;
$func$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS picks_tuple_hash_trigger ON picks;
CREATE TRIGGER picks_tuple_hash_trigger
  BEFORE INSERT OR UPDATE OF golfer_1_id, golfer_2_id, golfer_3_id, golfer_4_id
  ON picks
  FOR EACH ROW
  EXECUTE FUNCTION picks_compute_tuple_hash();

-- 4. Partial UNIQUE index — only enforced when the pick is complete.
--    Partial because picks rows can exist with NULL golfer_N_id
--    during in-progress submission flows (schema P3 #3.9 tracks
--    making those columns NOT NULL post-submit).
CREATE UNIQUE INDEX IF NOT EXISTS picks_unique_complete_foursome
  ON picks (league_id, tournament_id, golfer_tuple_hash)
  WHERE golfer_1_id IS NOT NULL
    AND golfer_2_id IS NOT NULL
    AND golfer_3_id IS NOT NULL
    AND golfer_4_id IS NOT NULL;

-- 5. Verify before committing
DO $verify$
DECLARE
  hash_count INTEGER;
  null_hash_count INTEGER;
  complete_picks INTEGER;
BEGIN
  SELECT COUNT(*) INTO complete_picks FROM picks
    WHERE golfer_1_id IS NOT NULL AND golfer_2_id IS NOT NULL
      AND golfer_3_id IS NOT NULL AND golfer_4_id IS NOT NULL;
  SELECT COUNT(*) INTO hash_count FROM picks WHERE golfer_tuple_hash IS NOT NULL;
  SELECT COUNT(*) INTO null_hash_count FROM picks
    WHERE golfer_tuple_hash IS NULL
      AND (golfer_1_id IS NOT NULL OR golfer_2_id IS NOT NULL
        OR golfer_3_id IS NOT NULL OR golfer_4_id IS NOT NULL);

  RAISE NOTICE 'Picks total: %, complete (4 golfers): %, with hash: %, unexpected null hashes: %',
    (SELECT COUNT(*) FROM picks), complete_picks, hash_count, null_hash_count;

  IF null_hash_count > 0 THEN
    RAISE EXCEPTION 'Backfill incomplete: % rows with golfer IDs but no hash', null_hash_count;
  END IF;
END $verify$;

COMMIT;
