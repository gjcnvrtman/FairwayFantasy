-- ============================================================
-- Migration 022 — per-league schedule + tournaments.hidden.
--
-- Two changes bundled because they're one product decision:
--
--   1. The "schedule" is now per-league, not "every global
--      tournament inside the league date window." A new
--      league_tournaments (league_id, tournament_id) join table
--      is the source of truth for what shows up on the Schedule
--      tab, in Picks, in History, and in scoring.
--
--   2. tournaments.hidden marks events we never want to auto-add
--      to any league (opposite-field/alternate PGA events).
--      Seeded TRUE for ISCO Championship + Corales Puntacana
--      Championship — the two events Greg asked to remove
--      2026-07-07.
--
-- Weekly ESPN schedule sync goes away in the same change (see
-- src/app/api/sync-scores/rankings/route.ts). Global tournaments
-- table is now populated once at league creation via
-- src/lib/schedule-import.ts; commissioners then add/remove
-- individual events on the AdminPanel Schedule section.
--
-- Backfill logic:
--   - Every existing league gets league_tournaments rows for
--     every non-hidden tournament whose start_date falls in the
--     league's start_date/end_date window. Matches the pre-022
--     behavior of the *InRange query helpers, so no league sees
--     its schedule shrink after this migration lands.
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/022-per-league-schedule.sql
-- ============================================================

BEGIN;

-- ── 1. tournaments.hidden ─────────────────────────────────────
ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;

-- Soft-delete the two events Greg named. ILIKE so we catch
-- ESPN's exact label regardless of "The" prefix or year suffix.
UPDATE tournaments
   SET hidden = TRUE
 WHERE name ILIKE '%ISCO Championship%'
    OR name ILIKE '%Corales Puntacana%';

-- ── 2. league_tournaments ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS league_tournaments (
  league_id     UUID NOT NULL REFERENCES leagues(id)     ON DELETE CASCADE,
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  added_by      UUID REFERENCES profiles(id),
  added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (league_id, tournament_id)
);

CREATE INDEX IF NOT EXISTS idx_league_tournaments_league_id
  ON league_tournaments (league_id);

CREATE INDEX IF NOT EXISTS idx_league_tournaments_tournament_id
  ON league_tournaments (tournament_id);

-- ── 3. Backfill existing leagues ──────────────────────────────
-- Match the pre-022 *InRange semantics: every non-hidden
-- tournament whose start_date is inside the league window
-- (nullable bounds treated as unbounded, same as the helpers).
INSERT INTO league_tournaments (league_id, tournament_id)
SELECT l.id, t.id
  FROM leagues l
  CROSS JOIN tournaments t
 WHERE t.hidden = FALSE
   AND (l.start_date IS NULL OR t.start_date >= l.start_date)
   AND (l.end_date   IS NULL OR t.start_date <= l.end_date)
ON CONFLICT DO NOTHING;

-- ── Verify ────────────────────────────────────────────────────
DO $verify$
DECLARE
  has_hidden BOOLEAN;
  has_table  BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'tournaments' AND column_name = 'hidden'
  ) INTO has_hidden;
  IF NOT has_hidden THEN
    RAISE EXCEPTION 'Migration 022 verify failed: tournaments.hidden missing';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_name = 'league_tournaments'
  ) INTO has_table;
  IF NOT has_table THEN
    RAISE EXCEPTION 'Migration 022 verify failed: league_tournaments missing';
  END IF;
END;
$verify$;

COMMIT;
