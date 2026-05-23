-- ============================================================
-- Migration 007: tournaments.field_published_at
-- 2026-05-23
--
-- Adds a nullable TIMESTAMPTZ column that stamps the first time
-- runFieldSync() observed ESPN return a non-empty competitors
-- collection for the tournament.
--
-- Semantics:
--   field_published_at IS NULL  → ESPN hasn't published the field;
--                                 picks page renders a "field not
--                                 yet available" banner; POST /api/picks
--                                 returns 409.
--   field_published_at NOT NULL → field is in the DB (via the
--                                 `scores` rows seeded at field-publish
--                                 time); picks UI shows the dropdown
--                                 filtered to JOIN scores ON tournament.
--
-- Existing rows back-fill to current timestamp ONLY for tournaments
-- that already have one or more rows in `scores` (i.e. fields that
-- were synced under the old logic). Rows without scores stay NULL
-- so the gating kicks in immediately for upcoming events.
-- ============================================================

BEGIN;

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS field_published_at TIMESTAMPTZ;

-- Back-fill: any tournament with at least one scores row was already
-- synced under the pre-007 logic, so its field is effectively
-- published. Stamp those rows so we don't lock picks for them.
UPDATE tournaments t
   SET field_published_at = NOW()
 WHERE field_published_at IS NULL
   AND EXISTS (SELECT 1 FROM scores s WHERE s.tournament_id = t.id);

COMMENT ON COLUMN tournaments.field_published_at IS
  'Timestamp of first observation of a non-empty ESPN competitors collection. '
  'NULL = picks locked (ESPN hasn''t published yet). '
  'Populated by runFieldSync() in src/lib/sync.ts.';

COMMIT;
