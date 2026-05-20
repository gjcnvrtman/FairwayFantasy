-- ============================================================
-- Migration 005 — picks.golfer_N_id columns NOT NULL.
--
-- Belt-and-suspenders for the existing app-layer enforcement.
-- validatePick (src/lib/scoring.ts) already rejects pick submissions
-- with any null slot at the API boundary, and POST /api/picks is
-- the only write path into picks. So the schema column-nullability
-- was a defense-in-depth gap, not an active bug:
--
--   * 0 rows in prod have any null slot (verified 2026-05-20
--     before this migration ran)
--   * a future code path that bypassed validatePick — or any
--     direct-DB write — could have inserted a partial row that
--     would later confuse the scoring engine (computeLeagueResults
--     defaults missing golfers to 0 fantasy points, so a partial
--     row could "win" tournaments by silently dropping golfers
--     into the cut-replacement floor)
--
-- Comment update: the existing partial-unique-index WHERE clause
-- (lines 173-180 of 00-schema.sql) is now strictly redundant since
-- every row guarantees the four columns are non-null, but we leave
-- it in place as belt-and-suspenders. No-op when columns are NOT
-- NULL; would re-engage if a future ALTER ever dropped NOT NULL.
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/005-picks-golfer-not-null.sql
--
-- Rollback (if ever needed):
--   ALTER TABLE picks
--     ALTER COLUMN golfer_1_id DROP NOT NULL,
--     ALTER COLUMN golfer_2_id DROP NOT NULL,
--     ALTER COLUMN golfer_3_id DROP NOT NULL,
--     ALTER COLUMN golfer_4_id DROP NOT NULL;
-- ============================================================

BEGIN;

-- Sanity check — refuse to run if any existing rows would fail.
-- ALTER ... SET NOT NULL would raise on its own, but a friendly
-- assertion gives a clearer error message and rolls back cleanly.
DO $picks_sanity$
DECLARE
  bad_count integer;
BEGIN
  SELECT COUNT(*)
    INTO bad_count
    FROM picks
   WHERE golfer_1_id IS NULL
      OR golfer_2_id IS NULL
      OR golfer_3_id IS NULL
      OR golfer_4_id IS NULL;
  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'Migration 005 aborted: % picks row(s) have null golfer slots. '
      'Reconcile or remove these rows before re-running.',
      bad_count;
  END IF;
END
$picks_sanity$;

ALTER TABLE picks
  ALTER COLUMN golfer_1_id SET NOT NULL,
  ALTER COLUMN golfer_2_id SET NOT NULL,
  ALTER COLUMN golfer_3_id SET NOT NULL,
  ALTER COLUMN golfer_4_id SET NOT NULL;

COMMIT;
