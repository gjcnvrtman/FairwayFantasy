-- ============================================================
-- Migration 013 — league_broadcasts audit log.
--
-- Records every commissioner / co-commissioner broadcast email sent
-- to all members of a league. Keeps a paper trail of who said what
-- to whom — useful when "I never got the merch deadline email" comes
-- up two months later. Also serves as the rate-limit lookup target
-- (max N broadcasts per league per 24h) inside the API handler.
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/013-league-broadcasts.sql
--
-- Rollback:
--   DROP TABLE league_broadcasts;
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS league_broadcasts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_id       UUID NOT NULL REFERENCES leagues(id)  ON DELETE CASCADE,
  sender_user_id  UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  recipient_count INT  NOT NULL DEFAULT 0,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_league_broadcasts_league_sent
  ON league_broadcasts (league_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_league_broadcasts_sender
  ON league_broadcasts (sender_user_id, sent_at DESC);

-- ── Verify ──
DO $verify$
DECLARE tbl_count INT;
BEGIN
  SELECT COUNT(*) INTO tbl_count FROM information_schema.tables
   WHERE table_name = 'league_broadcasts';
  IF tbl_count != 1 THEN
    RAISE EXCEPTION 'Migration 013 verify failed: league_broadcasts not created';
  END IF;
END;
$verify$;

COMMIT;
