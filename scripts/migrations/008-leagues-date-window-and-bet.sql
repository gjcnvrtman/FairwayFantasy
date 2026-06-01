-- ============================================================
-- Migration 008: leagues.start_date + leagues.end_date + leagues.weekly_bet_amount
-- 2026-05-30
--
-- Backfills the canonical schema with three columns that have been
-- referenced from code (and hand-applied on prod) for weeks but never
-- captured as a migration. As of 2026-05-23 nine source files read
-- these columns:
--
--   src/lib/sync.ts (notifyFieldPublished — worked around the gap by
--     refusing to filter by league date window; this migration
--     restores the proper filter)
--   src/app/league/[slug]/page.tsx (league dashboard)
--   src/app/league/[slug]/stats/page.tsx
--   src/app/league/[slug]/history/page.tsx
--   src/app/api/admin/league-settings/route.ts (admin POST)
--   src/app/api/admin/league-delete/route.ts (window check)
--   src/lib/money.ts (weekly_bet_amount → per-tournament dollar math)
--   src/app/league/[slug]/admin/page.tsx (commissioner UI)
--   src/lib/db/schema.ts (declares all three on LeaguesTable)
--
-- Implications without this migration:
--   (a) `npm run dev` against a fresh `00-schema.sql` install crashes
--       the schedule / money / admin paths the moment they query the
--       missing columns.
--   (b) Prod on .150 has always worked because the columns were
--       hand-applied via psql at some point — but that DDL was never
--       captured as a migration, leaving the canonical schema and
--       reality desynced.
--
-- Semantics:
--   start_date  — first tournament whose results count toward this
--                 league's season standings. NULL = no lower bound
--                 ("open from the beginning").
--   end_date    — last tournament whose results count. NULL = no
--                 upper bound ("open-ended").
--   weekly_bet_amount — dollar amount of the side bet per tournament,
--                       used by src/lib/money.ts. NOT NULL because
--                       money math doesn't have a sensible fallback;
--                       default 10.00 matches the prod-applied DDL.
--
-- All three columns are added with IF NOT EXISTS so this migration is
-- safe to re-apply on prod (where the columns already exist) AND on
-- fresh installs (where the columns will exist inline via the updated
-- 00-schema.sql below — also IF NOT EXISTS).
-- ============================================================

BEGIN;

ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS start_date        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS end_date          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS weekly_bet_amount NUMERIC(10,2) NOT NULL DEFAULT 10.00;

COMMENT ON COLUMN leagues.start_date IS
  'First tournament whose results count toward this league. NULL = no lower bound.';
COMMENT ON COLUMN leagues.end_date IS
  'Last tournament whose results count. NULL = no upper bound.';
COMMENT ON COLUMN leagues.weekly_bet_amount IS
  'Dollar side-bet per tournament. Used by src/lib/money.ts.';

-- Verify the columns landed (RAISE EXCEPTION fires if any are missing,
-- which would abort the transaction — same pattern as migration 001).
DO $$
DECLARE
  missing TEXT;
BEGIN
  SELECT string_agg(c, ', ') INTO missing
  FROM (VALUES ('start_date'), ('end_date'), ('weekly_bet_amount')) AS v(c)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'leagues' AND column_name = v.c
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 008: missing columns after ALTER: %', missing;
  END IF;
END $$;

COMMIT;
