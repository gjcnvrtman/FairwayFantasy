-- ============================================================
-- Migration 004 — reminder_preferences default-on backfill.
--
-- Pre-2026-05-19 the signup path created profile + auth_credentials +
-- league_member but did NOT create a reminder_preferences row. The
-- reminder engine treats "no row" as "no reminders" (explicit opt-in),
-- so every existing user was implicitly opted out — even though most
-- of them WANT pick reminders. Greg's call 2026-05-19: flip the
-- default to opt-in. Settings page still lets users toggle off.
--
-- Two changes:
--
--   (a) Backfill: for every profile that lacks a reminder_preferences
--       row, insert one with email_enabled=true, 24h before deadline.
--       Users who already have a row keep whatever choices they made.
--
--   (b) Going-forward: src/app/api/auth/register/route.ts now inserts
--       the default row inside the signup transaction, so new users
--       are opted in automatically. This migration handles existing
--       users who registered before that code shipped.
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/004-reminder-prefs-default-on.sql
--
-- Rollback (if ever needed):
--   DELETE FROM reminder_preferences
--   WHERE updated_at IS NULL  -- only the rows we just backfilled
--     AND email_enabled = true
--     AND sms_enabled = false
--     AND push_enabled = false
--     AND hours_before = 24;
-- ============================================================

BEGIN;

INSERT INTO reminder_preferences
  (user_id, email_enabled, sms_enabled, push_enabled, hours_before)
SELECT
  p.id, true, false, false, 24
FROM profiles p
WHERE NOT EXISTS (
  SELECT 1 FROM reminder_preferences rp WHERE rp.user_id = p.id
);

-- Sanity verify: every active profile now has a row.
DO $$
DECLARE
  missing INT;
BEGIN
  SELECT COUNT(*) INTO missing
  FROM profiles p
  WHERE NOT EXISTS (
    SELECT 1 FROM reminder_preferences rp WHERE rp.user_id = p.id
  );
  IF missing > 0 THEN
    RAISE EXCEPTION 'Backfill incomplete — % profile(s) still lack a reminder_preferences row', missing;
  END IF;
END $$;

COMMIT;
