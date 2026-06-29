-- ============================================================
-- Migration 016 — course_profiles + tournaments.course_profile_id.
--
-- Per-tournament hand-curated course profile. Holds the fantasy-fit
-- characteristics that the boys-weekend Course rows DON'T capture
-- (driving distance importance, approach difficulty, grass type,
-- expected scoring vs par for tour pros, comparable-course mapping).
-- Physical course data (par, yardage, etc.) can be seeded from
-- bw_courses + bw_course_holes via the admin "Seed from boys-weekend"
-- action — see the optional external_course_id link.
--
-- Design notes:
--  * One profile per tournament (per Greg's call). Memorial-at-
--    Muirfield-Village in 2026 and 2027 get separate profile rows.
--    Cheap dedup migration later if we ever want shared rows.
--  * The 5 importance values (driving_distance, driving_accuracy,
--    approach, around_green, putting) are independent 0..1 inputs.
--    Sum-to-1.0 normalization happens in course-fit.ts at scoring
--    time, NOT enforced at write time — curators may want all five
--    set mid-range for "balanced" courses.
--  * external_course_id is NULLABLE because some PGA venues (Augusta
--    National, Cypress Point, etc.) aren't in the boys-weekend
--    GolfCourseAPI dataset. Profile still works without the link;
--    physical fields just have to be entered by hand.
--  * comparable_course_ids is a UUID array referencing other
--    course_profiles.id rows. Postgres doesn't enforce FK arrays,
--    so cleanup on delete is application-side.
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/016-course-profiles.sql
--
-- Rollback:
--   ALTER TABLE tournaments DROP COLUMN course_profile_id;
--   DROP TABLE course_profiles;
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS course_profiles (
  id                            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Optional link to boys-weekend's Course.id (read via the FDW from
  -- migration 015). NULL when the venue isn't in that dataset.
  external_course_id            INT,

  name                          TEXT NOT NULL,

  -- Physical (auto-seedable from bw_course_holes / bw_courses).
  total_par                     INT,
  total_yardage                 INT,
  par_3_count                   INT,
  par_4_count                   INT,
  par_5_count                   INT,

  -- Surface.
  grass_type                    TEXT CHECK (
                                  grass_type IS NULL OR grass_type IN
                                  ('bermuda','bentgrass','poa_annua','rye','mixed','other')
                                ),

  -- Expected tour-pro scoring vs par over the event (+ve = harder).
  scoring_difficulty            NUMERIC(5,2),

  -- 5 independent course-fit importance weights, each 0..1.
  driving_distance_importance   NUMERIC(3,2)
                                CHECK (driving_distance_importance IS NULL
                                       OR (driving_distance_importance BETWEEN 0 AND 1)),
  driving_accuracy_importance   NUMERIC(3,2)
                                CHECK (driving_accuracy_importance IS NULL
                                       OR (driving_accuracy_importance BETWEEN 0 AND 1)),
  approach_importance           NUMERIC(3,2)
                                CHECK (approach_importance IS NULL
                                       OR (approach_importance BETWEEN 0 AND 1)),
  around_green_importance       NUMERIC(3,2)
                                CHECK (around_green_importance IS NULL
                                       OR (around_green_importance BETWEEN 0 AND 1)),
  putting_importance            NUMERIC(3,2)
                                CHECK (putting_importance IS NULL
                                       OR (putting_importance BETWEEN 0 AND 1)),

  -- Field-level stats.
  birdie_rate                   NUMERIC(4,3) CHECK (birdie_rate IS NULL OR (birdie_rate BETWEEN 0 AND 1)),
  bogey_rate                    NUMERIC(4,3) CHECK (bogey_rate  IS NULL OR (bogey_rate  BETWEEN 0 AND 1)),

  -- Comparable courses for "course history at similar venues" logic.
  -- Array of course_profiles.id refs (no FK; cleaned in app code).
  comparable_course_ids         UUID[],

  notes                         TEXT,
  curated_by                    UUID REFERENCES profiles(id),
  curated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_course_profiles_external
  ON course_profiles(external_course_id)
  WHERE external_course_id IS NOT NULL;

-- Tournaments link to (at most) one profile. NULL means "no profile
-- curated yet"; predictor refuses to run for these and reports a
-- clean "course profile missing" error.
ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS course_profile_id UUID REFERENCES course_profiles(id);

CREATE INDEX IF NOT EXISTS idx_tournaments_course_profile
  ON tournaments(course_profile_id)
  WHERE course_profile_id IS NOT NULL;

-- ── Verify ──
DO $verify$
DECLARE
  col_count INT;
  has_t_col BOOLEAN;
BEGIN
  SELECT COUNT(*) INTO col_count
    FROM information_schema.columns
   WHERE table_name = 'course_profiles';
  IF col_count < 19 THEN
    RAISE EXCEPTION
      'Migration 016 verify failed: course_profiles expected >=19 cols, got %', col_count;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'tournaments' AND column_name = 'course_profile_id'
  ) INTO has_t_col;
  IF NOT has_t_col THEN
    RAISE EXCEPTION
      'Migration 016 verify failed: tournaments.course_profile_id missing';
  END IF;
END;
$verify$;

COMMIT;
