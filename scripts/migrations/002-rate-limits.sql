-- ============================================================
-- Migration 002 — Per-IP rate limiting (P0 hardening).
--
-- Closes the rate-limit gap surfaced when Fairway went public-internet
-- exposed. Backs `src/lib/rate-limit.ts` with a single table; no new
-- infra (Fairway has no Redis), just a Postgres UPSERT per request.
--
-- Fixed-window strategy: each (endpoint, ip) pair gets one row whose
-- `window_start` resets to NOW() once the window has elapsed. Slight
-- under-counting under high concurrency is acceptable for abuse
-- prevention — false-pass risk is bounded by the window length.
--
-- Apply once per environment:
--   docker exec -i fairway-postgres psql -U fairway -d fairway \
--     < scripts/migrations/002-rate-limits.sql
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS rate_limits (
  key           TEXT        PRIMARY KEY,        -- e.g. "register:1.2.3.4"
  window_start  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  count         INT         NOT NULL DEFAULT 1,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index on window_start so cleanup queries are cheap.
CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start
  ON rate_limits (window_start);

COMMIT;
