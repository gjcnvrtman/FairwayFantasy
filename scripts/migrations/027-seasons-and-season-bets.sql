-- ============================================================
-- Migration 027 — seasons + season bets (2027 season, Phase 4).
--
-- Setup-time options on leagues (all locked with the rest of setup):
--   season_count               1..4. The league's scheduled
--                              tournaments split evenly into this many
--                              seasons, extras to the earlier ones.
--                              Computed from the schedule, not stored.
--   bet_team_cumulative        Bet ($) per player, per season, on the
--                              lowest cumulative team score (every
--                              golfer on the team, 6 on 6-man majors).
--                              NULL = off.
--   bet_top_tier_cumulative    Same, top-tier golfers only.
--   bet_dark_horse_cumulative  Same, dark-horse golfers only.
--   bets_add_penalties         Cumulative bets add missed-cut penalties
--                              (and the missed-deadline penalty on the
--                              team bet). Missed-cut golfers always count
--                              at their score through the cut.
--   bet_ace_bounty             $ every other member pays the owner of a
--                              golfer who makes a hole-in-one. NULL = off.
--
-- Settlement: every player in the season bets the amount; the lowest
-- total takes the whole pot (ties split it). Each season is its own
-- pot. $10 × 20 players → winner nets +$190.
--
-- league_ace_adjustments: commissioner corrections to auto-detected
-- aces (ESPN per-hole data can be incomplete) — 'add' credits an ace
-- the data missed, 'void' removes a detected one. Per league.
--
-- Defaults leave every existing league exactly as it is (1 season,
-- no bets).
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/027-seasons-and-season-bets.sql
-- ============================================================

BEGIN;

ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS season_count              INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS bet_team_cumulative       NUMERIC(10,2) NULL,
  ADD COLUMN IF NOT EXISTS bet_top_tier_cumulative   NUMERIC(10,2) NULL,
  ADD COLUMN IF NOT EXISTS bet_dark_horse_cumulative NUMERIC(10,2) NULL,
  ADD COLUMN IF NOT EXISTS bets_add_penalties        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bet_ace_bounty            NUMERIC(10,2) NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leagues_season_count_range') THEN
    ALTER TABLE leagues ADD CONSTRAINT leagues_season_count_range
      CHECK (season_count BETWEEN 1 AND 4);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leagues_season_bets_range') THEN
    ALTER TABLE leagues ADD CONSTRAINT leagues_season_bets_range CHECK (
      (bet_team_cumulative       IS NULL OR bet_team_cumulative       BETWEEN 0 AND 1000) AND
      (bet_top_tier_cumulative   IS NULL OR bet_top_tier_cumulative   BETWEEN 0 AND 1000) AND
      (bet_dark_horse_cumulative IS NULL OR bet_dark_horse_cumulative BETWEEN 0 AND 1000) AND
      (bet_ace_bounty            IS NULL OR bet_ace_bounty            BETWEEN 0 AND 1000)
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS league_ace_adjustments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id     UUID NOT NULL REFERENCES leagues(id)     ON DELETE CASCADE,
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  golfer_id     UUID NOT NULL REFERENCES golfers(id),
  round_num     INTEGER NOT NULL CHECK (round_num BETWEEN 1 AND 4),
  hole_num      INTEGER NOT NULL CHECK (hole_num BETWEEN 1 AND 18),
  action        TEXT NOT NULL CHECK (action IN ('add', 'void')),
  created_by    UUID NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (league_id, tournament_id, golfer_id, round_num, hole_num)
);

COMMIT;
