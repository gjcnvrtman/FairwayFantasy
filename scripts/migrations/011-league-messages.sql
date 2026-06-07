-- ============================================================
-- Migration 011 — league_messages (per-tournament smack board).
--
-- Per-tournament chat thread scoped to a single league. Each row is
-- one message authored by a league member, bound to a specific
-- tournament. The "board" resets every tournament: when the league
-- moves to next week's event, last week's trash talk stays in the
-- table but is no longer the default view.
--
-- Hard delete by commissioner / co_commissioner / message author —
-- the smack board isn't audit-tracked. If you want it gone, it's gone.
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/011-league-messages.sql
--
-- Rollback:
--   DROP TABLE league_messages;
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS league_messages (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_id      UUID NOT NULL REFERENCES leagues(id)     ON DELETE CASCADE,
  tournament_id  UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES profiles(id)    ON DELETE CASCADE,
  body           TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The hot read path is "newest N messages for (league, tournament)"
-- — the poll loop on the leaderboard page. Composite covers the
-- WHERE + ORDER BY in one index scan.
CREATE INDEX IF NOT EXISTS league_messages_thread_idx
  ON league_messages (league_id, tournament_id, created_at DESC);

-- Verify
DO $verify$
DECLARE
  t INT;
BEGIN
  SELECT COUNT(*) INTO t FROM information_schema.tables
    WHERE table_name = 'league_messages';
  IF t != 1 THEN
    RAISE EXCEPTION 'Migration 011 verify failed: league_messages not created';
  END IF;
END;
$verify$;

COMMIT;
