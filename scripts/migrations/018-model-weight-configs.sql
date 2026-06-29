-- ============================================================
-- Migration 018 — model_weight_configs (+ v1-default seed).
--
-- Versioned model-weight configurations for the course-fit
-- prediction system. Stores the 6 subscore weights and which one
-- is currently active. Predictor runs stamp the active config's id
-- onto each tournament_prediction_runs row so historical re-runs
-- are reproducible against the original weights even after the
-- active config changes.
--
-- Design notes:
--  * Six weights mirror the six course-fit subscores in spec:
--    course_fit, recent_form, long_term, course_history,
--    cut_probability, upside. Each is 0..1; in app code they MUST
--    sum to 1.0 within ±0.005. DB doesn't enforce the sum because
--    a multi-row UPDATE migrating between configs would briefly
--    violate it; CHECKs would fight the rebalance.
--  * `is_active` is a single-active boolean. The partial unique
--    index `WHERE is_active = TRUE` ensures at most one config is
--    active at any time. Setting another active in app code is a
--    two-statement transaction: UPDATE ... is_active = FALSE then
--    UPDATE ... is_active = TRUE.
--  * v1-default seed inserts the weights from Phase 1 spec
--    (30/20/15/15/10/10) and marks it active so day-one predictor
--    runs have a config to pick up.
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/018-model-weight-configs.sql
--
-- Rollback:
--   DROP TABLE model_weight_configs;
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS model_weight_configs (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                        TEXT NOT NULL UNIQUE,

  -- 6 subscore weights, each 0..1. Sum enforced in app code (Phase 3
  -- service layer), not in DB — see design note above.
  course_fit_weight           NUMERIC(3,2) NOT NULL CHECK (course_fit_weight       BETWEEN 0 AND 1),
  recent_form_weight          NUMERIC(3,2) NOT NULL CHECK (recent_form_weight      BETWEEN 0 AND 1),
  long_term_weight            NUMERIC(3,2) NOT NULL CHECK (long_term_weight        BETWEEN 0 AND 1),
  course_history_weight       NUMERIC(3,2) NOT NULL CHECK (course_history_weight   BETWEEN 0 AND 1),
  cut_probability_weight      NUMERIC(3,2) NOT NULL CHECK (cut_probability_weight  BETWEEN 0 AND 1),
  upside_weight               NUMERIC(3,2) NOT NULL CHECK (upside_weight           BETWEEN 0 AND 1),

  is_active                   BOOLEAN NOT NULL DEFAULT FALSE,
  description                 TEXT,
  created_by                  UUID REFERENCES profiles(id),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one active config at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_model_weight_one_active
  ON model_weight_configs(is_active)
  WHERE is_active = TRUE;

-- v1-default seed. Idempotent via ON CONFLICT.
INSERT INTO model_weight_configs (
  name,
  course_fit_weight, recent_form_weight, long_term_weight,
  course_history_weight, cut_probability_weight, upside_weight,
  is_active, description
)
VALUES (
  'v1-default',
  0.30, 0.20, 0.15, 0.15, 0.10, 0.10,
  TRUE,
  'Initial weights per Phase 1 spec (30/20/15/15/10/10). '
  || 'Adjust via the predictions/weights admin UI once enough '
  || 'backtest data has accumulated to justify changes.'
)
ON CONFLICT (name) DO NOTHING;

-- ── Verify ──
DO $verify$
DECLARE
  active_count INT;
  default_id   UUID;
BEGIN
  SELECT COUNT(*) INTO active_count FROM model_weight_configs WHERE is_active = TRUE;
  IF active_count != 1 THEN
    RAISE EXCEPTION
      'Migration 018 verify failed: expected exactly 1 active config, got %', active_count;
  END IF;

  SELECT id INTO default_id FROM model_weight_configs WHERE name = 'v1-default';
  IF default_id IS NULL THEN
    RAISE EXCEPTION 'Migration 018 verify failed: v1-default seed missing';
  END IF;
END;
$verify$;

COMMIT;
