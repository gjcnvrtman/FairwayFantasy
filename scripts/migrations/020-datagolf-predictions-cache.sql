-- ============================================================
-- Migration 020 — datagolf_tournament_predictions cache.
--
-- Local cache of Datagolf's per-tournament pre-tournament prediction
-- numbers (win / top-5 / top-10 / top-20 / make-cut). Refreshed weekly
-- by the fairway-datagolf.timer systemd unit. The predictor consumes
-- the latest row per (tournament, golfer) as one of its six subscore
-- inputs.
--
-- Design notes:
--  * UNIQUE on (tournament_id, datagolf_player_id) gives idempotent
--    re-pull upserts without needing partial indexes — datagolf_player_id
--    is always supplied by the API even when our local golfer_id is
--    NULL (unmatched).
--  * golfer_id is nullable on the same reasoning as
--    golfer_stat_snapshots: we still want the cached prediction
--    available for later re-linking when the matcher runs.
--  * raw_json stores the entire Datagolf response row keyed by their
--    field names so future model changes (e.g. they add a new column)
--    don't require schema migrations.
--  * pulled_at moves on every UPSERT so the predictor can refuse to
--    use cached data older than a configurable freshness window
--    (default: 14 days).
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/020-datagolf-predictions-cache.sql
--
-- Rollback:
--   DROP TABLE datagolf_tournament_predictions;
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS datagolf_tournament_predictions (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tournament_id         UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,

  -- Local linkage. NULL until the matcher links it; in the meantime
  -- the dg_id below carries the canonical identity.
  golfer_id             UUID REFERENCES golfers(id) ON DELETE SET NULL,

  -- Datagolf's stable internal player id. Always present in responses.
  datagolf_player_id    INT NOT NULL,
  player_name_raw       TEXT NOT NULL,

  pulled_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Probabilities returned as 0..1 (we normalize from datagolf's
  -- odds_format=percent which returns 0..100). All nullable in case
  -- a particular endpoint variant doesn't surface that field.
  win_prob              NUMERIC(6,5)
                        CHECK (win_prob       IS NULL OR (win_prob       BETWEEN 0 AND 1)),
  top_5_prob            NUMERIC(6,5)
                        CHECK (top_5_prob     IS NULL OR (top_5_prob     BETWEEN 0 AND 1)),
  top_10_prob           NUMERIC(6,5)
                        CHECK (top_10_prob    IS NULL OR (top_10_prob    BETWEEN 0 AND 1)),
  top_20_prob           NUMERIC(6,5)
                        CHECK (top_20_prob    IS NULL OR (top_20_prob    BETWEEN 0 AND 1)),
  make_cut_prob         NUMERIC(6,5)
                        CHECK (make_cut_prob  IS NULL OR (make_cut_prob  BETWEEN 0 AND 1)),

  -- Optional finish-position projection (Datagolf model output;
  -- not all model variants expose this).
  expected_finish       NUMERIC(6,2),

  raw_json              JSONB,

  UNIQUE (tournament_id, datagolf_player_id)
);

-- Reads are usually "predictions for THIS tournament" → fetch all
-- rows for tournament_id, join to golfers via golfer_id.
CREATE INDEX IF NOT EXISTS idx_dg_pred_tournament
  ON datagolf_tournament_predictions(tournament_id, pulled_at DESC);

-- For the matcher: find every cached row with no linked golfer yet.
CREATE INDEX IF NOT EXISTS idx_dg_pred_unmatched
  ON datagolf_tournament_predictions(datagolf_player_id)
  WHERE golfer_id IS NULL;

-- ── Verify ──
DO $verify$
DECLARE col_count INT;
BEGIN
  SELECT COUNT(*) INTO col_count
    FROM information_schema.columns
   WHERE table_name = 'datagolf_tournament_predictions';
  IF col_count < 13 THEN
    RAISE EXCEPTION
      'Migration 020 verify failed: expected >=13 columns, got %', col_count;
  END IF;
END;
$verify$;

COMMIT;
