-- ============================================================
-- Migration 014 — field_published_enabled per-user pref.
--
-- New dedicated toggle for the "ESPN published the tournament field,
-- go make your picks" email. Defaults TRUE so existing users start
-- opted in. Mirrors the nightly_recap_enabled / tournament_recap_enabled
-- pattern from migration 009.
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/014-field-published-pref.sql
--
-- Rollback:
--   ALTER TABLE reminder_preferences DROP COLUMN field_published_enabled;
-- ============================================================

BEGIN;

ALTER TABLE reminder_preferences
  ADD COLUMN IF NOT EXISTS field_published_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- ── Verify ──
DO $verify$
DECLARE col_count INT;
BEGIN
  SELECT COUNT(*) INTO col_count FROM information_schema.columns
   WHERE table_name='reminder_preferences'
     AND column_name='field_published_enabled';
  IF col_count != 1 THEN
    RAISE EXCEPTION 'Migration 014 verify failed: field_published_enabled not added';
  END IF;
END;
$verify$;

COMMIT;
