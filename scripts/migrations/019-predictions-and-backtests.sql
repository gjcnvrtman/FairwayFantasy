-- ============================================================
-- Migration 019 — prediction runs + golfer predictions + foursome
-- recommendations + backtest runs + backtest results.
--
-- 5 tables that hold the predictor's output:
--   1. tournament_prediction_runs   — one row per "run predictions"
--   2. golfer_predictions           — per-golfer scores for a run
--   3. foursome_recommendations     — top-5 foursomes for a run
--   4. backtest_runs                — historical replay aggregates
--   5. backtest_results             — per-event results within a run
--
-- Design notes:
--  * tournament_prediction_runs snapshots the weight_config_id used
--    so re-running predictions later (after the active weights change)
--    keeps the historical row reproducible. status field tracks the
--    async-ish lifecycle (pending / running / complete / failed).
--  * golfer_predictions composite PK (run_id, golfer_id) gives us
--    one row per (run, golfer). All subscores 0..100, composite 0..100.
--  * foursome_recommendations enforces rank uniqueness within a run
--    AND foursome_hash uniqueness within a run (no duplicate sets,
--    per Greg's rule). 5 rows per successful run.
--  * backtest_results uses JSONB `details` for per-golfer breakdown
--    so the drill-in view doesn't need a separate per-pick table.
--    Keeps the schema lean for v1.
--  * No FK from backtest_results.prediction_run_id is enforced as
--    NOT NULL because backtest can run inline without persisting a
--    full prediction run row (cheaper). v2 may tighten this.
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/019-predictions-and-backtests.sql
--
-- Rollback (reverse order — FKs cascade from runs to children):
--   DROP TABLE backtest_results;
--   DROP TABLE backtest_runs;
--   DROP TABLE foursome_recommendations;
--   DROP TABLE golfer_predictions;
--   DROP TABLE tournament_prediction_runs;
-- ============================================================

BEGIN;

-- ── 1. Prediction runs ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS tournament_prediction_runs (
  id                            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tournament_id                 UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  weight_config_id              UUID NOT NULL REFERENCES model_weight_configs(id),

  -- Which stat snapshot date was used (predictor picks latest snapshot
  -- AT-OR-BEFORE this date per golfer). NULL means "use whatever's
  -- latest as of run time" — discouraged but allowed for ad-hoc runs.
  stat_as_of_date               DATE,

  field_size                    INT,
  golfers_with_complete_stats   INT,
  golfers_with_missing_stats    INT,

  -- Free-form JSON describing what was missing so the UI can surface
  -- a clear "model running on partial data" banner.
  missing_inputs                JSONB,

  status                        TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','running','complete','failed')),
  error                         TEXT,
  triggered_by                  UUID REFERENCES profiles(id),
  started_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at                  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pred_runs_tournament
  ON tournament_prediction_runs(tournament_id, started_at DESC);

-- ── 2. Per-golfer prediction scores ────────────────────────
CREATE TABLE IF NOT EXISTS golfer_predictions (
  run_id                        UUID NOT NULL REFERENCES tournament_prediction_runs(id) ON DELETE CASCADE,
  golfer_id                     UUID NOT NULL REFERENCES golfers(id),

  -- Per-tournament-field tier classification (from field-tiers.ts).
  is_top_tier                   BOOLEAN NOT NULL,

  -- 6 subscores, 0..100.
  course_fit_score              NUMERIC(5,2),
  recent_form_score             NUMERIC(5,2),
  long_term_score               NUMERIC(5,2),
  course_history_score          NUMERIC(5,2),
  cut_probability_score         NUMERIC(5,2),
  upside_score                  NUMERIC(5,2),

  -- Composite 0..100.
  composite_score               NUMERIC(5,2) NOT NULL,

  -- Derived inputs the optimizer consumes.
  projected_strokes_to_par      NUMERIC(5,2),
  projected_cut_made_prob       NUMERIC(4,3) CHECK (
                                  projected_cut_made_prob IS NULL
                                  OR (projected_cut_made_prob BETWEEN 0 AND 1)
                                ),

  -- Human-readable explanation surfaced in the UI tooltip.
  explanation                   TEXT,

  PRIMARY KEY (run_id, golfer_id)
);

-- ── 3. Foursome recommendations ────────────────────────────
CREATE TABLE IF NOT EXISTS foursome_recommendations (
  id                            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id                        UUID NOT NULL REFERENCES tournament_prediction_runs(id) ON DELETE CASCADE,
  rank                          INT NOT NULL CHECK (rank BETWEEN 1 AND 5),

  top_tier_1_golfer_id          UUID NOT NULL REFERENCES golfers(id),
  top_tier_2_golfer_id          UUID NOT NULL REFERENCES golfers(id),
  dark_horse_1_golfer_id        UUID NOT NULL REFERENCES golfers(id),
  dark_horse_2_golfer_id        UUID NOT NULL REFERENCES golfers(id),

  -- Reuses src/lib/scoring.ts:computeFoursomeHash. Order-independent
  -- set hash of the 4 ids.
  foursome_hash                 TEXT NOT NULL,

  -- Expected best-3-of-4 sum + missed-cut penalty (lower = better).
  projected_fantasy_score       NUMERIC(6,2) NOT NULL,

  confidence_score              NUMERIC(4,3) NOT NULL
                                CHECK (confidence_score BETWEEN 0 AND 1),
  risk_level                    TEXT NOT NULL
                                CHECK (risk_level IN ('conservative','balanced','aggressive')),

  -- % of submitted picks in any league that already include this
  -- foursome's golfers, computed at recommendation time. NULL when
  -- no picks exist yet for the tournament.
  estimated_ownership_pct       NUMERIC(4,1),

  key_strengths                 TEXT[],
  key_concerns                  TEXT[],
  foursome_explanation          TEXT,

  -- Invariants Greg called out: rank uniqueness + foursome dedup.
  UNIQUE (run_id, rank),
  UNIQUE (run_id, foursome_hash)
);

-- ── 4. Backtest runs (aggregate) ───────────────────────────
CREATE TABLE IF NOT EXISTS backtest_runs (
  id                            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  weight_config_id              UUID NOT NULL REFERENCES model_weight_configs(id),

  -- Which tournaments were tested. UUID[] (not a join table) because
  -- backtest membership is set-once-at-creation; mutations would need
  -- a re-run, not an UPDATE.
  tournament_ids                UUID[] NOT NULL,

  status                        TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','running','complete','failed')),

  -- Aggregate metrics computed after all per-event results land.
  events_tested                 INT,
  events_with_complete_data     INT,
  avg_projected_vs_actual       NUMERIC(6,2),
  avg_best_foursome_rank        NUMERIC(5,2),
  pct_beat_league_average       NUMERIC(4,1),
  pct_beat_league_winner        NUMERIC(4,1),
  avg_sleeper_accuracy          NUMERIC(4,3),

  notes                         TEXT,
  triggered_by                  UUID REFERENCES profiles(id),
  started_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at                  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_backtest_runs_started
  ON backtest_runs(started_at DESC);

-- ── 5. Backtest results (per-event) ────────────────────────
CREATE TABLE IF NOT EXISTS backtest_results (
  id                            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  backtest_run_id               UUID NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  tournament_id                 UUID NOT NULL REFERENCES tournaments(id),
  prediction_run_id             UUID REFERENCES tournament_prediction_runs(id),

  -- Per-event metrics.
  projected_score               NUMERIC(6,2),
  actual_score                  NUMERIC(6,2),
  best_recommended_rank_in_league INT,
  beat_league_average           BOOLEAN,
  beat_league_winner            BOOLEAN,
  avg_finish_recommended        NUMERIC(5,2),
  made_cut_pct                  NUMERIC(4,1),
  top_10_pct                    NUMERIC(4,1),
  top_20_pct                    NUMERIC(4,1),
  total_fantasy_points          NUMERIC(6,2),

  -- Gap to the optimal legal foursome (computed post-hoc with full
  -- knowledge of actual results).
  regret_score                  NUMERIC(6,2),

  -- Dark-horse hit rate: fraction of recommended dark-horses that
  -- finished in the field's top half.
  sleeper_accuracy              NUMERIC(4,3),

  -- Drill-in detail (per-golfer breakdown, foursome composition,
  -- league member counterfactual).
  details                       JSONB,

  UNIQUE (backtest_run_id, tournament_id)
);

CREATE INDEX IF NOT EXISTS idx_backtest_results_tournament
  ON backtest_results(tournament_id);

-- ── Verify ──
DO $verify$
DECLARE
  table_count INT;
BEGIN
  SELECT COUNT(*) INTO table_count
    FROM information_schema.tables
   WHERE table_name IN (
     'tournament_prediction_runs',
     'golfer_predictions',
     'foursome_recommendations',
     'backtest_runs',
     'backtest_results'
   );
  IF table_count != 5 THEN
    RAISE EXCEPTION
      'Migration 019 verify failed: expected 5 tables, got %', table_count;
  END IF;
END;
$verify$;

COMMIT;
