-- ============================================================
-- Migration 015 — postgres_fdw bootstrap + boys-weekend foreign tables.
--
-- Phase-3 cross-DB read path. Course profiles (migration 016) and the
-- "seed from boys-weekend" admin action need to read course rows that
-- live in the sister project's database `golf_boys_weekend` on the
-- same Postgres instance. Rather than duplicate ~30 rows here, we use
-- postgres_fdw to read them lazily.
--
-- Design notes:
--  * Connection is fixed to localhost (both DBs are colocated on the
--    same Postgres container today). If FairwayFantasy ever moves
--    DBs, the SERVER `bw_db` host needs to change too.
--  * CREATE USER MAPPING does NOT support IF NOT EXISTS on the
--    Postgres version on prod (17), so the existence checks are
--    done in DO blocks. The whole migration is idempotent.
--  * Foreign tables are LAZY — they do not validate connectivity at
--    creation time. First SELECT against bw_courses is what tests
--    the link. That's deliberate: dev environments without a local
--    golf_boys_weekend DB still apply this migration cleanly; queries
--    against the foreign tables surface a clean error at use-time.
--  * Password is the dev-grade `golf` literal also used by the
--    boys-weekend backend's DATABASE_URL. The boys-weekend DB only
--    accepts connections from localhost so this is not a real-world
--    secret. Rotate via ALTER USER MAPPING if it ever becomes one.
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/015-postgres-fdw-courses.sql
--
-- Rollback:
--   DROP FOREIGN TABLE bw_course_holes;
--   DROP FOREIGN TABLE bw_courses;
--   DROP USER MAPPING FOR fairway SERVER bw_db;
--   DROP SERVER bw_db;
--   DROP EXTENSION postgres_fdw;
-- ============================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgres_fdw;

-- Server (idempotent via existence check).
DO $bootstrap_server$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_foreign_server WHERE srvname = 'bw_db') THEN
    CREATE SERVER bw_db
      FOREIGN DATA WRAPPER postgres_fdw
      OPTIONS (host 'localhost', port '5432', dbname 'golf_boys_weekend');
  END IF;
END;
$bootstrap_server$;

-- User mapping (idempotent via existence check).
DO $bootstrap_mapping$
DECLARE
  has_mapping BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_user_mappings
     WHERE srvname  = 'bw_db'
       AND usename  = 'fairway'
  ) INTO has_mapping;
  IF NOT has_mapping THEN
    CREATE USER MAPPING FOR fairway
      SERVER bw_db
      OPTIONS (user 'golf', password 'golf');
  END IF;
END;
$bootstrap_mapping$;

-- Foreign tables. Quote camelCase Prisma column names exactly.
CREATE FOREIGN TABLE IF NOT EXISTS bw_courses (
  id     INT,
  name   TEXT,
  city   TEXT,
  state  TEXT,
  lat    FLOAT8,
  lng    FLOAT8,
  rating FLOAT8,
  slope  INT
) SERVER bw_db OPTIONS (table_name 'Course');

CREATE FOREIGN TABLE IF NOT EXISTS bw_course_holes (
  id            INT,
  "courseId"    INT,
  "holeNumber"  INT,
  par           INT,
  "strokeIndex" INT,
  yardages      JSONB
) SERVER bw_db OPTIONS (table_name 'CourseHole');

-- ── Verify ──
-- Note: cannot SELECT from foreign tables in DO block reliably
-- (the lazy connection may fail in dev). We only verify metadata.
DO $verify$
DECLARE
  srv_count INT;
  ft_count  INT;
BEGIN
  SELECT COUNT(*) INTO srv_count FROM pg_foreign_server WHERE srvname = 'bw_db';
  IF srv_count != 1 THEN
    RAISE EXCEPTION 'Migration 015 verify failed: bw_db server missing';
  END IF;

  SELECT COUNT(*) INTO ft_count
    FROM pg_class
   WHERE relkind = 'f'
     AND relname IN ('bw_courses', 'bw_course_holes');
  IF ft_count != 2 THEN
    RAISE EXCEPTION
      'Migration 015 verify failed: expected 2 foreign tables, got %', ft_count;
  END IF;
END;
$verify$;

COMMIT;
