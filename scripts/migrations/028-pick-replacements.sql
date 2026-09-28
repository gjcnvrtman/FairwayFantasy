-- ============================================================
-- Migration 028 — WD replacements are per pick, not tournament-wide.
--
-- Bug (found 2026-09-23): PUT /api/picks recorded a withdrawal swap by
-- setting scores.was_replaced + replaced_by_golfer_id on the
-- tournament-wide score row. Every player in every league who picked
-- that golfer then silently got the replacement's score — including
-- players who never chose a replacement.
--
-- Fix: the swap lives on the player's own pick, per slot. Scoring
-- reads pick_replacements; scores.was_replaced / replaced_by_golfer_id
-- are no longer read or written (left in place, unused).
--
-- Backfill: any existing tournament-wide swap is copied onto every
-- pick that held the withdrawn golfer, so already-computed results
-- would recompute identically. (Prod had 0 such rows on 2026-09-28.)
--
-- Requires migration 026 (golfer_5_id / golfer_6_id).
--
-- Apply:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/028-pick-replacements.sql
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS pick_replacements (
  pick_id               UUID NOT NULL REFERENCES picks(id) ON DELETE CASCADE,
  slot                  INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 6),
  original_golfer_id    UUID NOT NULL REFERENCES golfers(id),
  replacement_golfer_id UUID NOT NULL REFERENCES golfers(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pick_id, slot)
);

INSERT INTO pick_replacements (pick_id, slot, original_golfer_id, replacement_golfer_id)
SELECT p.id, x.slot, s.golfer_id, s.replaced_by_golfer_id
FROM scores s
JOIN picks p ON p.tournament_id = s.tournament_id
CROSS JOIN LATERAL (VALUES
  (1, p.golfer_1_id), (2, p.golfer_2_id), (3, p.golfer_3_id),
  (4, p.golfer_4_id), (5, p.golfer_5_id), (6, p.golfer_6_id)
) AS x(slot, gid)
WHERE s.was_replaced
  AND s.replaced_by_golfer_id IS NOT NULL
  AND x.gid = s.golfer_id
ON CONFLICT DO NOTHING;

COMMIT;
