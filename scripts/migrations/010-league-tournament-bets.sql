-- ============================================================
-- Migration 010 — league_tournament_bets.
--
-- Per-(league, tournament) bet override. The league-wide
-- `leagues.weekly_bet_amount` (added 2026-06-01 in migration 008)
-- is the league's default bet; commissioners can override it on
-- a per-tournament basis from the admin page's Tournament Status
-- section (2026-06-06).
--
-- Resolution at read time:
--   COALESCE(league_tournament_bets.bet_amount, leagues.weekly_bet_amount)
--
-- Editability is gated to status='upcoming' tournaments at the
-- API layer (`/api/admin/tournament-bet`) so we don't retroactively
-- shift settled money on active/cut_made/complete tournaments.
--
-- Why a new table and not a column on `tournaments`:
--   The pick_deadline_override on `tournaments` is GLOBAL — one
--   value applies to every league. Bets are league-scoped (each
--   league sets its own amount for the same tournament), so the
--   override has to live in a (league, tournament) join table.
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/010-league-tournament-bets.sql
--
-- Rollback:
--   DROP TABLE league_tournament_bets;
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS league_tournament_bets (
  league_id      UUID NOT NULL REFERENCES leagues(id)     ON DELETE CASCADE,
  tournament_id  UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  bet_amount     NUMERIC(10,2) NOT NULL CHECK (bet_amount >= 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (league_id, tournament_id)
);

-- Lookup indexes:
--   - Reverse direction "given a tournament, which leagues override it?"
--     is rare; the PK already covers the forward direction.
--   - The (league_id, tournament_id) PK is enough for the money path's
--     SELECT WHERE league_id=$1 AND tournament_id IN (...).
CREATE INDEX IF NOT EXISTS league_tournament_bets_tournament_idx
  ON league_tournament_bets (tournament_id);

-- Verify
DO $verify$
DECLARE
  t INT;
BEGIN
  SELECT COUNT(*) INTO t FROM information_schema.tables
    WHERE table_name = 'league_tournament_bets';
  IF t != 1 THEN
    RAISE EXCEPTION 'Migration 010 verify failed: league_tournament_bets not created';
  END IF;
END;
$verify$;

COMMIT;
