-- ============================================================
-- Migration 021 — bw_courses_cache + bw_course_holes_cache.
--
-- Local mirror of the boys-weekend Course + CourseHole tables. The
-- bridge SLICE shipped 2026-06-29 PM lets the course-profile form
-- search this cache and autofill physical fields (par, yardage,
-- par counts) so admins don't re-key the data manually.
--
-- Topology:
--   - boys-weekend lives in golf_boys_weekend on host Postgres 17
--   - fairway lives in fairway on Docker Postgres 16
--   - The two Postgres instances are isolated; this cache is the
--     "Path B" we agreed on (over Path A's pg_hba changes).
--   - scripts/sync-bw-courses.ts populates it (idempotent upsert).
--
-- Column-name mapping (Prisma → snake_case):
--   Course.id          → bw_courses_cache.id
--   Course.name        → bw_courses_cache.name
--   Course.lat / lng   → lat / lng
--   Course.rating      → rating
--   Course.slope       → slope
--   ...
--   CourseHole."courseId" → bw_course_holes_cache.course_id
--   CourseHole."holeNumber" → hole_number
--   CourseHole."strokeIndex" → stroke_index
--   yardages JSONB → yardages JSONB (kept verbatim)
--
-- The original boys-weekend `id` (INT) is preserved so the
-- course_profiles.external_course_id link continues to point at
-- the same number whether we use FDW (rejected) or cache (this).
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/021-bw-courses-cache.sql
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS bw_courses_cache (
  id            INT PRIMARY KEY,             -- mirror of boys-weekend Course.id
  name          TEXT NOT NULL,
  address       TEXT,
  city          TEXT,
  state         TEXT,
  zip           TEXT,
  phone         TEXT,
  website       TEXT,
  tee_time_url  TEXT,
  google_maps_url TEXT,
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION,
  rating        DOUBLE PRECISION,            -- USGA course rating
  slope         INT,                          -- USGA slope
  notes         TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE,

  -- Pre-computed roll-ups from CourseHole. Filled in by the sync
  -- script using the holes table; serving search results doesn't
  -- need a join.
  total_par         INT,
  total_yardage     INT,                    -- championship-tee best-effort
  par_3_count       INT,
  par_4_count       INT,
  par_5_count       INT,
  hole_count        INT,

  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Case-insensitive prefix/substring search hot path.
CREATE INDEX IF NOT EXISTS idx_bw_courses_name_lower
  ON bw_courses_cache (LOWER(name));

CREATE INDEX IF NOT EXISTS idx_bw_courses_state
  ON bw_courses_cache (state);

CREATE TABLE IF NOT EXISTS bw_course_holes_cache (
  id            INT PRIMARY KEY,             -- mirror of CourseHole.id
  course_id     INT NOT NULL REFERENCES bw_courses_cache(id) ON DELETE CASCADE,
  hole_number   INT NOT NULL,
  par           INT NOT NULL,
  stroke_index  INT,
  yardages      JSONB,                       -- { "TPC (Men)": 395, ... }
  UNIQUE (course_id, hole_number)
);

CREATE INDEX IF NOT EXISTS idx_bw_holes_by_course
  ON bw_course_holes_cache (course_id, hole_number);

-- ── Verify ──
DO $verify$
DECLARE col_count INT;
BEGIN
  SELECT COUNT(*) INTO col_count
    FROM information_schema.columns
   WHERE table_name = 'bw_courses_cache';
  IF col_count < 20 THEN
    RAISE EXCEPTION
      'Migration 021 verify failed: expected >=20 cols on bw_courses_cache, got %', col_count;
  END IF;
END;
$verify$;

COMMIT;
