-- ============================================================
-- FAIRWAY FANTASY — self-hosted Postgres schema
-- Auto-applied on first container start (mounted at
-- /docker-entrypoint-initdb.d/). Re-running requires either a
-- volume reset (`docker compose down -v`) or running individual
-- statements via `psql`.
--
-- Differences from supabase/schema.sql (the historical Supabase
-- Cloud schema, kept as reference):
--   1. No `REFERENCES auth.users(id)` — Fairway runs its own auth
--      via NextAuth Credentials, no Supabase auth schema exists.
--   2. No RLS policies — application-level auth (requireCommissioner
--      etc.) is the source of truth. RLS was belt-and-suspenders
--      that has to be torn down anyway since `auth.uid()` doesn't
--      exist outside Supabase.
--   3. New `auth_credentials` table for password hashes + verify
--      tokens (Phase 4 of the golf-czar migration uses it).
--
-- The hand-written kysely types in `src/lib/db/schema.ts` mirror
-- this file. If you change one, change both.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- LEAGUES
-- ============================================================
CREATE TABLE leagues (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  invite_code     TEXT NOT NULL UNIQUE,
  commissioner_id UUID,
  max_players     INT DEFAULT 20,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PROFILES — user identity surface used everywhere in app code.
-- Phase-4 swap: stays UUID, no FK to any external auth table.
-- ============================================================
CREATE TABLE profiles (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  display_name  TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- AUTH_CREDENTIALS — separated from profiles so password material
-- isn't pulled into every profile read.
--
-- Populated in Phase 5 cutover by importing bcrypt hashes out of
-- Supabase's auth.users. Existing users keep their current passwords.
-- New signups (Phase 4 NextAuth Credentials provider) write here.
-- ============================================================
CREATE TABLE auth_credentials (
  user_id              UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  password_hash        TEXT NOT NULL,         -- bcrypt cost ≥ 10

  -- Email verification — does NOT gate login. Surfaced as a UI
  -- banner. Wired in once SMTP is configured.
  email_verified       BOOLEAN NOT NULL DEFAULT FALSE,
  verify_token         TEXT UNIQUE,
  verify_token_expires TIMESTAMPTZ,

  -- Password reset — same SMTP dependency.
  reset_token          TEXT UNIQUE,
  reset_token_expires  TIMESTAMPTZ,

  last_login_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_auth_credentials_verify_token ON auth_credentials(verify_token)
  WHERE verify_token IS NOT NULL;
CREATE INDEX idx_auth_credentials_reset_token  ON auth_credentials(reset_token)
  WHERE reset_token IS NOT NULL;

-- ============================================================
-- LEAGUE_MEMBERS
-- ============================================================
CREATE TABLE league_members (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_id   UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role        TEXT DEFAULT 'member' CHECK (role IN ('commissioner', 'member')),
  joined_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(league_id, user_id)
);

-- ============================================================
-- TOURNAMENTS
-- ============================================================
CREATE TABLE tournaments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  espn_event_id   TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  type            TEXT DEFAULT 'regular' CHECK (type IN ('regular', 'major')),
  season          INT NOT NULL,
  start_date      TIMESTAMPTZ NOT NULL,
  end_date        TIMESTAMPTZ NOT NULL,
  pick_deadline   TIMESTAMPTZ,
  cut_score       INT,
  status          TEXT DEFAULT 'upcoming'
                  CHECK (status IN ('upcoming','active','cut_made','complete')),
  course_name     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- GOLFERS
-- ============================================================
CREATE TABLE golfers (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  espn_id         TEXT NOT NULL UNIQUE,
  datagolf_id     INT,
  name            TEXT NOT NULL,
  owgr_rank       INT,
  is_dark_horse   BOOLEAN GENERATED ALWAYS AS (owgr_rank > 24) STORED,
  headshot_url    TEXT,
  country         TEXT,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PICKS
-- ============================================================
CREATE TABLE picks (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_id          UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  tournament_id      UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  golfer_1_id        UUID REFERENCES golfers(id),   -- Top tier
  golfer_2_id        UUID REFERENCES golfers(id),   -- Top tier
  golfer_3_id        UUID REFERENCES golfers(id),   -- Dark horse
  golfer_4_id        UUID REFERENCES golfers(id),   -- Dark horse
  -- Sorted-tuple hash for DB-backed uniqueness (P0 #3.2). Maintained
  -- by trigger below; do not write directly. The partial unique
  -- index further down enforces "no two users in the same league
  -- can submit the same 4 golfers" even under concurrent inserts.
  golfer_tuple_hash  TEXT,
  is_locked          BOOLEAN DEFAULT FALSE,
  submitted_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(league_id, tournament_id, user_id)
);

-- Recompute golfer_tuple_hash on insert and whenever one of the
-- golfer_N_id columns changes. Sorts the 4 IDs by their text repr
-- so the hash is order-independent.
CREATE OR REPLACE FUNCTION picks_compute_tuple_hash() RETURNS trigger AS $picks_hash$
BEGIN
  NEW.golfer_tuple_hash := (
    SELECT string_agg(g::text, '|' ORDER BY g)
    FROM unnest(ARRAY[NEW.golfer_1_id, NEW.golfer_2_id,
                      NEW.golfer_3_id, NEW.golfer_4_id]) AS g
  );
  RETURN NEW;
END;
$picks_hash$ LANGUAGE plpgsql;

CREATE TRIGGER picks_tuple_hash_trigger
  BEFORE INSERT OR UPDATE OF golfer_1_id, golfer_2_id, golfer_3_id, golfer_4_id
  ON picks
  FOR EACH ROW
  EXECUTE FUNCTION picks_compute_tuple_hash();

-- Partial UNIQUE index — only enforced when all 4 golfers are
-- non-null, so in-progress / partial picks don't collide.
CREATE UNIQUE INDEX picks_unique_complete_foursome
  ON picks (league_id, tournament_id, golfer_tuple_hash)
  WHERE golfer_1_id IS NOT NULL
    AND golfer_2_id IS NOT NULL
    AND golfer_3_id IS NOT NULL
    AND golfer_4_id IS NOT NULL;

-- ============================================================
-- SCORES
-- ============================================================
CREATE TABLE scores (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tournament_id         UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  golfer_id             UUID NOT NULL REFERENCES golfers(id) ON DELETE CASCADE,
  espn_golfer_id        TEXT NOT NULL,
  round_1               INT,
  round_2               INT,
  round_3               INT,
  round_4               INT,
  total_strokes         INT,
  score_to_par          INT,
  position              TEXT,
  status                TEXT DEFAULT 'active' CHECK (
    status IN ('active', 'missed_cut', 'withdrawn', 'disqualified', 'complete')
  ),
  fantasy_score         INT,
  was_replaced          BOOLEAN DEFAULT FALSE,
  replaced_by_golfer_id UUID REFERENCES golfers(id),
  last_synced           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tournament_id, golfer_id)
);

-- ============================================================
-- FANTASY_RESULTS
-- ============================================================
CREATE TABLE fantasy_results (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_id         UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  tournament_id     UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  golfer_1_score    INT,
  golfer_2_score    INT,
  golfer_3_score    INT,
  golfer_4_score    INT,
  counting_golfers  INT[],
  total_score       INT,
  rank              INT,
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(league_id, tournament_id, user_id)
);

-- ============================================================
-- SEASON_STANDINGS
-- ============================================================
CREATE TABLE season_standings (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_id          UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  season             INT NOT NULL,
  total_score        INT DEFAULT 0,
  tournaments_played INT DEFAULT 0,
  best_finish        INT,
  rank               INT,
  updated_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(league_id, user_id, season)
);

-- ============================================================
-- REMINDER_PREFERENCES (Prompt 9)
-- ============================================================
CREATE TABLE reminder_preferences (
  user_id        UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  email_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  sms_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  push_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  hours_before   INT NOT NULL DEFAULT 24
                 CHECK (hours_before > 0 AND hours_before <= 168),
  email_addr     TEXT,
  phone_e164     TEXT,
  push_token     TEXT,
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- REMINDER_LOG (Prompt 9 — audit + idempotency)
-- ============================================================
CREATE TABLE reminder_log (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  league_id      UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  tournament_id  UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  channel        TEXT NOT NULL CHECK (channel IN ('email','sms','push','console')),
  status         TEXT NOT NULL CHECK (status IN ('console','sent','failed','skipped')),
  error_message  TEXT,
  sent_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, tournament_id, channel)
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_league_members_league          ON league_members(league_id);
CREATE INDEX idx_league_members_user            ON league_members(user_id);
CREATE INDEX idx_picks_league_tournament        ON picks(league_id, tournament_id);
CREATE INDEX idx_scores_tournament              ON scores(tournament_id);
CREATE INDEX idx_fantasy_results_league         ON fantasy_results(league_id, tournament_id);
CREATE INDEX idx_season_standings_league        ON season_standings(league_id, season);
CREATE INDEX idx_golfers_owgr                   ON golfers(owgr_rank);
CREATE INDEX idx_tournaments_status             ON tournaments(status);
CREATE INDEX idx_reminder_log_tournament        ON reminder_log(tournament_id);
CREATE INDEX idx_reminder_log_user              ON reminder_log(user_id);

-- ============================================================
-- NOTES
-- ============================================================
-- RLS is intentionally not configured. App-level enforcement via
-- requireCommissioner / requireMember (src/lib/auth-league.ts) is
-- the source of truth. Adding RLS back later is fine; it'd be
-- belt-and-suspenders, not a primary defense.
--
-- Original Supabase schema in supabase/schema.sql is kept for
-- reference / historical comparison. Delete after Phase 5 cutover.
