-- ============================================================
-- Migration 026 — 6-man teams for majors (2027 season, Phase 3).
--
-- Setup option: leagues.major_team_size = 4 | 6.
--   4 (default, and every existing league) — unchanged: 2 top tier +
--     2 dark horse, best 3 count.
--   6 — on MAJORS only: 3 top tier + 3 dark horse, best 4 count.
--     Regular events stay 4-man.
--
-- Schema:
--   picks.golfer_5_id / golfer_6_id          — NULL for 4-man teams;
--                                              both set for 6-man.
--   fantasy_results.golfer_5_score / _6_score — NULL for 4-man.
--
-- No-copycats trigger now hashes all six slots. string_agg skips
-- NULLs, so every existing 4-man pick keeps its exact hash — the
-- migration verifies that before committing.
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/026-six-man-majors.sql
-- ============================================================

BEGIN;

ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS major_team_size INTEGER NOT NULL DEFAULT 4;

ALTER TABLE picks
  ADD COLUMN IF NOT EXISTS golfer_5_id UUID NULL REFERENCES golfers(id),
  ADD COLUMN IF NOT EXISTS golfer_6_id UUID NULL REFERENCES golfers(id);

ALTER TABLE fantasy_results
  ADD COLUMN IF NOT EXISTS golfer_5_score INT NULL,
  ADD COLUMN IF NOT EXISTS golfer_6_score INT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leagues_major_team_size_valid') THEN
    ALTER TABLE leagues ADD CONSTRAINT leagues_major_team_size_valid
      CHECK (major_team_size IN (4, 6));
  END IF;
  -- Slots 5 and 6 are set together or not at all.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'picks_slots_5_6_paired') THEN
    ALTER TABLE picks ADD CONSTRAINT picks_slots_5_6_paired
      CHECK ((golfer_5_id IS NULL) = (golfer_6_id IS NULL));
  END IF;
END $$;

-- Snapshot existing hashes so we can prove the new trigger doesn't
-- change any of them.
CREATE TEMP TABLE pre_026_hashes ON COMMIT DROP AS
  SELECT id, golfer_tuple_hash FROM picks;

CREATE OR REPLACE FUNCTION picks_compute_tuple_hash() RETURNS trigger AS $func$
BEGIN
  NEW.golfer_tuple_hash := (
    SELECT string_agg(g::text, '|' ORDER BY g)
    FROM unnest(ARRAY[NEW.golfer_1_id, NEW.golfer_2_id, NEW.golfer_3_id,
                      NEW.golfer_4_id, NEW.golfer_5_id, NEW.golfer_6_id]) AS g
  );
  RETURN NEW;
END;
$func$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS picks_tuple_hash_trigger ON picks;
CREATE TRIGGER picks_tuple_hash_trigger
  BEFORE INSERT OR UPDATE OF golfer_1_id, golfer_2_id, golfer_3_id,
                             golfer_4_id, golfer_5_id, golfer_6_id
  ON picks
  FOR EACH ROW
  EXECUTE FUNCTION picks_compute_tuple_hash();

-- Verify: recomputing with the new expression leaves every existing
-- hash unchanged.
DO $verify$
DECLARE
  changed INTEGER;
BEGIN
  SELECT COUNT(*) INTO changed
  FROM picks p JOIN pre_026_hashes h ON h.id = p.id
  WHERE h.golfer_tuple_hash IS DISTINCT FROM (
    SELECT string_agg(g::text, '|' ORDER BY g)
    FROM unnest(ARRAY[p.golfer_1_id, p.golfer_2_id, p.golfer_3_id,
                      p.golfer_4_id, p.golfer_5_id, p.golfer_6_id]) AS g
  );
  IF changed > 0 THEN
    RAISE EXCEPTION 'Migration 026: % existing pick hash(es) would change', changed;
  END IF;
END $verify$;

COMMIT;
