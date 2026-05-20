-- ============================================================
-- Migration 006 — add co_commissioner role.
--
-- The original CHECK constraint allowed only ('commissioner', 'member').
-- This migration broadens it to ('commissioner', 'co_commissioner',
-- 'member') so a league commissioner can deputize trusted members
-- with operational access (sync scores, send reminders, set pick
-- deadlines, regenerate invite codes, remove members) WITHOUT
-- granting structural powers (league delete, settings edit, role
-- changes).
--
-- Permission tiers enforced at the app layer:
--
--   commissioner    — everything (creator of the league)
--                     + can promote/demote co_commissioners
--                     + can delete the league
--                     + can edit league settings
--   co_commissioner — operational actions only
--                     + cannot remove commissioner or other co_commissioner
--                     + cannot change anyone's role
--   member          — pick submission, invite friends, view-only otherwise
--
-- Orphan prevention: wouldOrphanLeague() still counts only
-- `commissioner` role. A league with 0 commissioners and N
-- co_commissioners is functionally orphaned because nobody can
-- promote new co's or delete the league.
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/006-co-commissioner-role.sql
--
-- Rollback (if ever needed):
--   ALTER TABLE league_members DROP CONSTRAINT league_members_role_check;
--   ALTER TABLE league_members
--     ADD CONSTRAINT league_members_role_check
--     CHECK (role IN ('commissioner', 'member'));
--   -- If any rows have role='co_commissioner', downgrade first:
--   -- UPDATE league_members SET role='member' WHERE role='co_commissioner';
-- ============================================================

BEGIN;

ALTER TABLE league_members DROP CONSTRAINT IF EXISTS league_members_role_check;

ALTER TABLE league_members
  ADD CONSTRAINT league_members_role_check
  CHECK (role IN ('commissioner', 'co_commissioner', 'member'));

COMMIT;
