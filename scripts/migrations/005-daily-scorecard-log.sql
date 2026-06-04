-- ============================================================
-- Migration 005 — daily_scorecard_log dedup table.
--
-- The daily-scorecard email (sent post-round-complete by
-- sync.ts:detectAndSendDailyScorecards) must fire exactly ONCE per
-- (league, tournament, round). The detection step runs from
-- runScoreSync every 10 minutes Thu-Sun; without dedup it would
-- re-send every cycle once the round-complete condition latches.
--
-- This table records "we sent for this (league, tournament, round)".
-- Insert with ON CONFLICT DO NOTHING guards against double-send under
-- concurrent runs and across worker restarts.
--
-- Shape mirrors picks-foursome-hash dedup pattern (migration 001):
-- single UNIQUE-indexed marker table, no payload, no retention
-- concerns (a few rows per league per tournament).
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS daily_scorecard_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_id       UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  tournament_id   UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  round_num       INT NOT NULL CHECK (round_num >= 1 AND round_num <= 4),
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Number of emails this round produced — useful for telemetry
  -- without re-querying league_members + computing the diff.
  emails_sent     INT NOT NULL DEFAULT 0,
  UNIQUE(league_id, tournament_id, round_num)
);

CREATE INDEX IF NOT EXISTS daily_scorecard_log_tournament_idx
  ON daily_scorecard_log (tournament_id);

DO $verify$
DECLARE t INT;
BEGIN
  SELECT COUNT(*) INTO t FROM information_schema.tables
   WHERE table_name='daily_scorecard_log';
  IF t != 1 THEN
    RAISE EXCEPTION 'Migration 005 verify failed: daily_scorecard_log not created';
  END IF;
END;
$verify$;

COMMIT;
