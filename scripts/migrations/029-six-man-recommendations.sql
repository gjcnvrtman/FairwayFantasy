-- ============================================================
-- Migration 029 — six-man team recommendations for 6-man majors.
--
-- Leagues can play 6-man majors (migration 026: 3 top-tier + 3 dark
-- horse, best 4 of 6 count). The predictor now also recommends a top 5
-- of those teams when a major is on the schedule of a 6-man league.
--
-- foursome_recommendations gains:
--   team_size              4 (existing foursomes, default) or 6
--   top_tier_3_golfer_id   } set only for team_size = 6
--   dark_horse_3_golfer_id }
-- Rank / hash uniqueness becomes per (run, team_size) so a run can hold
-- a top 5 of each.
--
-- Existing rows are foursomes: team_size defaults to 4, new columns NULL.
--
-- Apply:
--   docker exec -i fairway-postgres psql -v ON_ERROR_STOP=1 -U fairway -d fairway \
--     < scripts/migrations/029-six-man-recommendations.sql
-- ============================================================

BEGIN;

ALTER TABLE foursome_recommendations
  ADD COLUMN IF NOT EXISTS team_size INT NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS top_tier_3_golfer_id   UUID REFERENCES golfers(id),
  ADD COLUMN IF NOT EXISTS dark_horse_3_golfer_id UUID REFERENCES golfers(id);

ALTER TABLE foursome_recommendations
  DROP CONSTRAINT IF EXISTS foursome_recommendations_team_size_check,
  ADD  CONSTRAINT foursome_recommendations_team_size_check
       CHECK (team_size IN (4, 6)),
  DROP CONSTRAINT IF EXISTS foursome_recommendations_six_slots_check,
  ADD  CONSTRAINT foursome_recommendations_six_slots_check
       CHECK ((team_size = 4 AND top_tier_3_golfer_id IS NULL AND dark_horse_3_golfer_id IS NULL)
           OR (team_size = 6 AND top_tier_3_golfer_id IS NOT NULL AND dark_horse_3_golfer_id IS NOT NULL));

-- Uniqueness per (run, team_size).
ALTER TABLE foursome_recommendations
  DROP CONSTRAINT IF EXISTS foursome_recommendations_run_id_rank_key,
  DROP CONSTRAINT IF EXISTS foursome_recommendations_run_id_foursome_hash_key,
  DROP CONSTRAINT IF EXISTS foursome_recommendations_run_size_rank_key,
  DROP CONSTRAINT IF EXISTS foursome_recommendations_run_size_hash_key,
  ADD  CONSTRAINT foursome_recommendations_run_size_rank_key UNIQUE (run_id, team_size, rank),
  ADD  CONSTRAINT foursome_recommendations_run_size_hash_key UNIQUE (run_id, team_size, foursome_hash);

COMMIT;
