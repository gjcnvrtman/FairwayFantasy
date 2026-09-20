-- ============================================================
-- Migration 024 — per-(league, tournament) payout snapshots.
--
-- Motivation: when a commissioner edits the league-wide payout
-- split (migration 023), we don't want to retroactively rewrite
-- displayed payouts for tournaments that already locked. Greg's
-- rule (2026-09-20): "retroactive — no. going forward only."
--
-- Freeze rule (implemented in /api/admin/league-settings):
--   - When admin edits the league-level payout_pct_*, we FIRST
--     snapshot the OLD values into this table for every tournament
--     in the league whose pick_deadline is already in the past
--     (i.e., picks are locked). Then we write the new league
--     values.
--   - Missing row = tournament is still pre-lock OR was never
--     touched by an edit. Money math falls back to the current
--     leagues.payout_pct_* in that case (which will re-enter this
--     table the next time an edit happens after that tournament
--     locks).
--
-- Semantics mirror the existing league_tournament_bets table
-- (migration 010, per-tournament bet override) — same shape,
-- same fallback pattern — but the write TRIGGER is different:
-- bets are opt-in commissioner overrides; payouts are automatic
-- pre-write snapshots.
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/024-league-tournament-payouts.sql
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS league_tournament_payouts (
  league_id     UUID NOT NULL REFERENCES leagues(id)     ON DELETE CASCADE,
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  payout_pct_1  INTEGER NOT NULL,
  payout_pct_2  INTEGER NOT NULL,
  payout_pct_3  INTEGER NOT NULL,
  snapshot_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (league_id, tournament_id),
  CONSTRAINT league_tournament_payouts_sum_100
    CHECK (payout_pct_1 + payout_pct_2 + payout_pct_3 = 100),
  CONSTRAINT league_tournament_payouts_nonneg
    CHECK (payout_pct_1 >= 0 AND payout_pct_2 >= 0 AND payout_pct_3 >= 0)
);

-- Row-hunt indexes for the two dominant read shapes:
--   (a) load ALL snapshots for a given league at page-render time
--       (money-math callers) — served by the PK's leading column,
--       no extra index needed.
--   (b) sweep by tournament (unlikely, but cheap to support if
--       migrations ever need to touch across leagues).
CREATE INDEX IF NOT EXISTS league_tournament_payouts_tournament_idx
  ON league_tournament_payouts (tournament_id);

COMMIT;
