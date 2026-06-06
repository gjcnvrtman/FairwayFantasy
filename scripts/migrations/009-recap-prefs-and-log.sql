-- ============================================================
-- Migration 009 — recap preferences + tournament_recap_log.
--
-- Two changes for the new Account page (2026-06-06):
--
--   (a) Per-user opt-out for the post-round daily-scorecard email
--       (`nightly_recap_enabled`) and for the new end-of-tournament
--       recap email (`tournament_recap_enabled`). Both default TRUE
--       so existing users keep receiving what they already get —
--       only people who explicitly toggle off on the Account page
--       are excluded.
--
--   (b) `tournament_recap_log` mirrors `daily_scorecard_log` from
--       migration 005: a UNIQUE (league_id, tournament_id) marker
--       so the recap fires exactly once per (user-facing) tournament
--       even though `runScoreSync` runs every 10 minutes Thu-Sun.
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/009-recap-prefs-and-log.sql
--
-- Rollback:
--   ALTER TABLE reminder_preferences
--     DROP COLUMN nightly_recap_enabled,
--     DROP COLUMN tournament_recap_enabled;
--   DROP TABLE tournament_recap_log;
-- ============================================================

BEGIN;

-- ── (a) New opt-out columns on reminder_preferences ──
ALTER TABLE reminder_preferences
  ADD COLUMN IF NOT EXISTS nightly_recap_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS tournament_recap_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- ── (b) Tournament-recap dedup log ──
CREATE TABLE IF NOT EXISTS tournament_recap_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_id       UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  tournament_id   UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  emails_sent     INT NOT NULL DEFAULT 0,
  UNIQUE(league_id, tournament_id)
);

CREATE INDEX IF NOT EXISTS tournament_recap_log_tournament_idx
  ON tournament_recap_log (tournament_id);

-- ── Verify ──
DO $verify$
DECLARE
  col_count INT;
  tbl_count INT;
BEGIN
  SELECT COUNT(*) INTO col_count FROM information_schema.columns
   WHERE table_name='reminder_preferences'
     AND column_name IN ('nightly_recap_enabled','tournament_recap_enabled');
  IF col_count != 2 THEN
    RAISE EXCEPTION 'Migration 009 verify failed: expected 2 new columns on reminder_preferences, got %', col_count;
  END IF;

  SELECT COUNT(*) INTO tbl_count FROM information_schema.tables
   WHERE table_name='tournament_recap_log';
  IF tbl_count != 1 THEN
    RAISE EXCEPTION 'Migration 009 verify failed: tournament_recap_log not created';
  END IF;
END;
$verify$;

COMMIT;
