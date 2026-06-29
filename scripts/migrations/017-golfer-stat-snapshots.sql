-- ============================================================
-- Migration 017 — golfer_stat_snapshots.
--
-- Snapshot table for golfer statistics imported via CSV (and later
-- the admin UI in /predictions/stats). Each row is one golfer's set
-- of stats as-of a specific date. Phase 3 / course-fit prediction
-- system reads the latest snapshot at-or-before each tournament's
-- pick_deadline as the model input.
--
-- Design notes:
--  * golfer_id is NULLABLE. CSV uploads come in with names; matching
--    against golfers.name is best-effort fuzzy. Unmatched rows are
--    still inserted (with golfer_id NULL) so the upload audit trail
--    survives — the admin can fix the match later and re-link the row.
--    The partial unique index below only fires for matched rows.
--  * All stat columns are NULLABLE. We allow partial CSVs so v1
--    callers can ship "OWGR + recent finishes only" snapshots and the
--    predictor handles missing inputs gracefully.
--  * raw_json captures the entire original CSV row keyed by header so
--    a later import audit can replay or correct any field.
--  * source defaults to 'csv_upload' but is open-text so an automated
--    scraper (v2) can stamp itself separately ('pgatour_scrape',
--    'datagolf_api', etc.) without a schema change.
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/017-golfer-stat-snapshots.sql
--
-- Rollback:
--   DROP TABLE golfer_stat_snapshots;
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS golfer_stat_snapshots (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  golfer_id             UUID REFERENCES golfers(id) ON DELETE CASCADE,
  golfer_name_raw       TEXT NOT NULL,
  as_of_date            DATE NOT NULL,
  source                TEXT NOT NULL DEFAULT 'csv_upload',

  -- Strokes Gained (per round, vs field). Signed; positive = above field.
  sg_total              NUMERIC(5,3),
  sg_ott                NUMERIC(5,3),
  sg_app                NUMERIC(5,3),
  sg_arg                NUMERIC(5,3),
  sg_putt               NUMERIC(5,3),

  -- Driving / approach skill.
  driving_distance      NUMERIC(5,1),         -- yards
  driving_accuracy_pct  NUMERIC(4,1),         -- 0..100
  gir_pct               NUMERIC(4,1),         -- 0..100

  -- Scoring / consistency.
  scoring_avg           NUMERIC(5,2),         -- raw stroke avg, e.g. 69.45
  birdie_avg            NUMERIC(4,2),         -- birdies per round
  bogey_avg             NUMERIC(4,2),         -- bogeys per round
  made_cut_pct          NUMERIC(4,1),         -- 0..100

  -- Audit.
  raw_json              JSONB,
  uploaded_by           UUID REFERENCES profiles(id),
  uploaded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One snapshot per (golfer, date) — re-uploads upsert in app code.
-- Partial index so unmatched rows (NULL golfer_id) can coexist for
-- the same as_of_date without colliding.
CREATE UNIQUE INDEX IF NOT EXISTS uq_stat_snap_golfer_date
  ON golfer_stat_snapshots(golfer_id, as_of_date)
  WHERE golfer_id IS NOT NULL;

-- For the admin "unmatched" review queue.
CREATE INDEX IF NOT EXISTS idx_stat_snap_unmatched
  ON golfer_stat_snapshots(uploaded_at DESC)
  WHERE golfer_id IS NULL;

-- For "give me the most-recent snapshot at-or-before D for this golfer"
-- which is the hot path the predictor hits per-golfer per-run.
CREATE INDEX IF NOT EXISTS idx_stat_snap_golfer_asof
  ON golfer_stat_snapshots(golfer_id, as_of_date DESC)
  WHERE golfer_id IS NOT NULL;

-- ── Verify ──
DO $verify$
DECLARE
  col_count INT;
  idx_count INT;
BEGIN
  SELECT COUNT(*) INTO col_count
    FROM information_schema.columns
   WHERE table_name = 'golfer_stat_snapshots';
  IF col_count < 18 THEN
    RAISE EXCEPTION
      'Migration 017 verify failed: expected >=18 columns, got %', col_count;
  END IF;

  SELECT COUNT(*) INTO idx_count
    FROM pg_indexes
   WHERE tablename = 'golfer_stat_snapshots';
  -- 1 pk + 3 partial indexes = 4
  IF idx_count < 4 THEN
    RAISE EXCEPTION
      'Migration 017 verify failed: expected >=4 indexes, got %', idx_count;
  END IF;
END;
$verify$;

COMMIT;
