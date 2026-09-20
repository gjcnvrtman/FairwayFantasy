-- ============================================================
-- Migration 023 — configurable top-3 payout percentages per league.
--
-- Before: leagues awarded 100% of the pot to rank-1 (tie-for-1st
--         splits evenly among co-winners).
--
-- After:  each league defines a top-3 payout split — integers summing
--         to 100 — and the pot distributes accordingly using the
--         PGA combined-share tie rule (tied players occupy adjacent
--         ranks; the shares for the ranks they occupy get combined
--         and split evenly among them, so the pot is always fully
--         allocated when the top 3 ranks exist).
--
-- Defaults 100/0/0 so every existing league keeps current winner-
-- take-all behavior with no admin action required. Change per-league
-- from the /league/<slug>/admin League Settings card.
--
-- CHECK constraint enforces the sum-to-100 invariant at the DB level.
-- Non-negative constraint blocks admin fat-finger of a negative value.
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/023-league-payout-percentages.sql
-- ============================================================

BEGIN;

ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS payout_pct_1 INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS payout_pct_2 INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payout_pct_3 INTEGER NOT NULL DEFAULT 0;

-- Sum-to-100 + nonneg. Named so admin-UI errors can reference the
-- constraint by name if needed. IF NOT EXISTS is not supported for
-- CHECK constraints in older Postgres; wrap in a DO block that no-ops
-- if the constraint already exists (idempotent re-runs).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leagues_payout_pcts_sum_100'
  ) THEN
    ALTER TABLE leagues
      ADD CONSTRAINT leagues_payout_pcts_sum_100
      CHECK (payout_pct_1 + payout_pct_2 + payout_pct_3 = 100);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leagues_payout_pcts_nonneg'
  ) THEN
    ALTER TABLE leagues
      ADD CONSTRAINT leagues_payout_pcts_nonneg
      CHECK (payout_pct_1 >= 0 AND payout_pct_2 >= 0 AND payout_pct_3 >= 0);
  END IF;
END $$;

-- Verify (belt-and-suspenders — will RAISE if backfill left any row
-- outside the invariant, which shouldn't happen since the DEFAULT
-- fills at ADD COLUMN time).
DO $$
DECLARE
  bad_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_count FROM leagues
    WHERE payout_pct_1 + payout_pct_2 + payout_pct_3 <> 100;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Migration 023: % league rows have payout_pct sum != 100', bad_count;
  END IF;
END $$;

COMMIT;
