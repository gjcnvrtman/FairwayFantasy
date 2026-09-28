-- ============================================================
-- Migration 025 — setup-time league rules (2027 season, Phase 1).
--
-- New per-league rule columns:
--   major_bet_amount         NUMERIC(10,2) NULL — stake for majors.
--                            NULL = same as weekly_bet_amount.
--   missed_cut_penalty       INTEGER — strokes added per missed-cut
--                            golfer. Default 1 (pre-025 constant).
--   missed_deadline_penalty  INTEGER — strokes added to an auto-
--                            assigned lineup. Default 2 (pre-025
--                            constant).
--   setup_status             'legacy' | 'setup' | 'locked'
--     legacy — every league that existed before this migration. Keeps
--              its current editable admin behavior, unchanged.
--     setup  — a league created with the new setup flow. Commissioner
--              can adjust rules + schedule until it locks.
--     locked — rules, bets, penalties, window and schedule are frozen.
--              Set by the commissioner's "Lock league setup" button,
--              or automatically once any scheduled tournament's pick
--              deadline passes (src/lib/league-setup.ts).
--   setup_locked_at          TIMESTAMPTZ NULL — when it locked.
--
-- Defaults reproduce pre-025 behavior exactly, so existing leagues
-- see no change.
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/025-league-setup-rules.sql
-- ============================================================

BEGIN;

ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS major_bet_amount        NUMERIC(10,2) NULL,
  ADD COLUMN IF NOT EXISTS missed_cut_penalty      INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS missed_deadline_penalty INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS setup_status            TEXT    NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS setup_locked_at         TIMESTAMPTZ NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leagues_major_bet_range') THEN
    ALTER TABLE leagues ADD CONSTRAINT leagues_major_bet_range
      CHECK (major_bet_amount IS NULL OR (major_bet_amount >= 0 AND major_bet_amount <= 1000));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leagues_missed_cut_penalty_range') THEN
    ALTER TABLE leagues ADD CONSTRAINT leagues_missed_cut_penalty_range
      CHECK (missed_cut_penalty BETWEEN 0 AND 10);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leagues_missed_deadline_penalty_range') THEN
    ALTER TABLE leagues ADD CONSTRAINT leagues_missed_deadline_penalty_range
      CHECK (missed_deadline_penalty BETWEEN 0 AND 10);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leagues_setup_status_valid') THEN
    ALTER TABLE leagues ADD CONSTRAINT leagues_setup_status_valid
      CHECK (setup_status IN ('legacy', 'setup', 'locked'));
  END IF;
END $$;

COMMIT;
