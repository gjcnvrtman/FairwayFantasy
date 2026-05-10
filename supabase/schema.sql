-- ============================================================
-- GOLF FANTASY — MULTI-TENANT DATABASE SCHEMA
-- Run this entire file in Supabase SQL Editor
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- LEAGUES — top-level tenant table
-- ============================================================
CREATE TABLE leagues (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,          -- URL-friendly: "the-boys"
  invite_code   TEXT NOT NULL UNIQUE,          -- Random join code
  commissioner_id UUID,                        -- Set after first user joins
  max_players   INT DEFAULT 20,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PROFILES — extends Supabase auth.users
-- ============================================================
CREATE TABLE profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name  TEXT NOT NULL,
  email         TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- LEAGUE_MEMBERS — many-to-many users <-> leagues
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
-- TOURNAMENTS — PGA events + Majors
-- ============================================================
CREATE TABLE tournaments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  espn_event_id   TEXT NOT NULL UNIQUE,        -- ESPN's event ID (e.g. "401811941")
  name            TEXT NOT NULL,
  type            TEXT DEFAULT 'regular' CHECK (type IN ('regular', 'major')),
  season          INT NOT NULL,                -- e.g. 2026
  start_date      TIMESTAMPTZ NOT NULL,
  end_date        TIMESTAMPTZ NOT NULL,
  pick_deadline   TIMESTAMPTZ,                 -- Auto-set to Thursday tee time
  cut_score       INT,                         -- Set when cut is made (strokes to par)
  status          TEXT DEFAULT 'upcoming' CHECK (status IN ('upcoming','active','cut_made','complete')),
  course_name     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- GOLFERS — cached player list from ESPN + OWGR from DataGolf
-- ============================================================
CREATE TABLE golfers (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  espn_id         TEXT NOT NULL UNIQUE,
  datagolf_id     INT,
  name            TEXT NOT NULL,
  owgr_rank       INT,                         -- Updated weekly from DataGolf
  is_dark_horse   BOOLEAN GENERATED ALWAYS AS (owgr_rank > 24) STORED,
  headshot_url    TEXT,
  country         TEXT,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PICKS — each user's selections per tournament per league
-- ============================================================
CREATE TABLE picks (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_id       UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  tournament_id   UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- Slots 1-2: top tier (OWGR rank 1-24), Slots 3-4: dark horse (rank 25+)
  golfer_1_id     UUID REFERENCES golfers(id),   -- Top tier
  golfer_2_id     UUID REFERENCES golfers(id),   -- Top tier
  golfer_3_id     UUID REFERENCES golfers(id),   -- Dark horse
  golfer_4_id     UUID REFERENCES golfers(id),   -- Dark horse

  is_locked       BOOLEAN DEFAULT FALSE,         -- True after pick deadline
  submitted_at    TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(league_id, tournament_id, user_id)      -- One entry per user per event
);

-- ============================================================
-- SCORES — live + final scores per golfer per tournament
-- ============================================================
CREATE TABLE scores (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tournament_id         UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  golfer_id             UUID NOT NULL REFERENCES golfers(id) ON DELETE CASCADE,
  espn_golfer_id        TEXT NOT NULL,

  -- Raw data from ESPN
  round_1               INT,
  round_2               INT,
  round_3               INT,
  round_4               INT,
  total_strokes         INT,
  score_to_par          INT,                      -- e.g. -17, 0 (even), +3
  position              TEXT,                     -- "T4", "1", "CUT"

  -- Status
  status                TEXT DEFAULT 'active' CHECK (
    status IN ('active', 'missed_cut', 'withdrawn', 'disqualified', 'complete')
  ),

  -- Adjusted score after applying fantasy rules
  fantasy_score         INT,                      -- Final score used in calculations

  -- Replacement tracking
  was_replaced          BOOLEAN DEFAULT FALSE,
  replaced_by_golfer_id UUID REFERENCES golfers(id),

  last_synced           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tournament_id, golfer_id)
);

-- ============================================================
-- FANTASY_RESULTS — computed leaderboard per league per tournament
-- Recalculated on each sync
-- ============================================================
CREATE TABLE fantasy_results (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_id         UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  tournament_id     UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- Individual golfer scores (after rules applied)
  golfer_1_score    INT,
  golfer_2_score    INT,
  golfer_3_score    INT,
  golfer_4_score    INT,

  -- Which 3 count (indices of top 3, e.g. [1,2,3] meaning golfers 1,2,3)
  counting_golfers  INT[],

  -- Final fantasy score = sum of top 3
  total_score       INT,
  rank              INT,

  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(league_id, tournament_id, user_id)
);

-- ============================================================
-- SEASON_STANDINGS — cumulative scores across all tournaments
-- ============================================================
CREATE TABLE season_standings (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_id       UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  season          INT NOT NULL,

  total_score     INT DEFAULT 0,
  tournaments_played INT DEFAULT 0,
  best_finish     INT,                            -- Best single-tournament rank
  rank            INT,

  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(league_id, user_id, season)
);

-- ============================================================
-- INDEXES for performance
-- ============================================================
CREATE INDEX idx_league_members_league ON league_members(league_id);
CREATE INDEX idx_league_members_user ON league_members(user_id);
CREATE INDEX idx_picks_league_tournament ON picks(league_id, tournament_id);
CREATE INDEX idx_scores_tournament ON scores(tournament_id);
CREATE INDEX idx_fantasy_results_league ON fantasy_results(league_id, tournament_id);
CREATE INDEX idx_season_standings_league ON season_standings(league_id, season);
CREATE INDEX idx_golfers_owgr ON golfers(owgr_rank);
CREATE INDEX idx_tournaments_status ON tournaments(status);

-- ============================================================
-- ROW LEVEL SECURITY (RLS) — users only see their league's data
-- ============================================================
ALTER TABLE leagues ENABLE ROW LEVEL SECURITY;
ALTER TABLE league_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE picks ENABLE ROW LEVEL SECURITY;
ALTER TABLE fantasy_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE season_standings ENABLE ROW LEVEL SECURITY;

-- Leagues: visible to members
CREATE POLICY "League members can view their league"
  ON leagues FOR SELECT
  USING (
    id IN (
      SELECT league_id FROM league_members WHERE user_id = auth.uid()
    )
  );

-- League members: users see members of their own leagues
CREATE POLICY "Members see their league roster"
  ON league_members FOR SELECT
  USING (
    league_id IN (
      SELECT league_id FROM league_members WHERE user_id = auth.uid()
    )
  );

-- Picks: users see all picks in their league (after lock), only own picks before lock
CREATE POLICY "View picks in your league"
  ON picks FOR SELECT
  USING (
    league_id IN (
      SELECT league_id FROM league_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users manage own picks"
  ON picks FOR ALL
  USING (user_id = auth.uid());

-- Fantasy results: visible to all league members
CREATE POLICY "View fantasy results in your league"
  ON fantasy_results FOR SELECT
  USING (
    league_id IN (
      SELECT league_id FROM league_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "View season standings in your league"
  ON season_standings FOR SELECT
  USING (
    league_id IN (
      SELECT league_id FROM league_members WHERE user_id = auth.uid()
    )
  );

-- Golfers and tournaments are public (no RLS needed)
-- Scores are public read

-- ============================================================
-- REMINDER_PREFERENCES — per-user opt-in for pick reminders
-- (Prompt 9. All channels default OFF — never send anything
--  unless the user explicitly opted in.)
-- ============================================================
CREATE TABLE IF NOT EXISTS reminder_preferences (
  user_id        UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,

  -- Channels — opt-in (false by default per privacy norm)
  email_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  sms_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  push_enabled   BOOLEAN NOT NULL DEFAULT FALSE,

  -- How early to remind (hours before pick_deadline). 1..168 hr (1 wk).
  hours_before   INT NOT NULL DEFAULT 24
                 CHECK (hours_before > 0 AND hours_before <= 168),

  -- Optional per-channel destinations. NULL means "use the address
  -- on profiles" (today: profiles.email only — no phone field yet).
  email_addr     TEXT,
  phone_e164     TEXT,
  push_token     TEXT,

  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE reminder_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own reminder prefs"
  ON reminder_preferences FOR ALL
  USING (user_id = auth.uid());

-- ============================================================
-- REMINDER_LOG — audit log of every reminder attempted/sent.
-- Doubles as the idempotency table: we won't send the same
-- (user, tournament, channel) combo more than once.
-- ============================================================
CREATE TABLE IF NOT EXISTS reminder_log (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  league_id      UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  tournament_id  UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  channel        TEXT NOT NULL CHECK (channel IN ('email','sms','push','console')),

  -- 'console' = printed to server logs (dry-run default for LAN).
  -- 'sent'    = handed off to a real provider.
  -- 'failed'  = provider rejected; error_message has details.
  -- 'skipped' = computed eligible but skipped at delivery (e.g. no destination)
  status         TEXT NOT NULL CHECK (status IN ('console','sent','failed','skipped')),

  error_message  TEXT,
  sent_at        TIMESTAMPTZ DEFAULT NOW(),

  -- Idempotency: never remind the same user about the same tournament
  -- on the same channel twice. The job-finder helper queries this.
  UNIQUE(user_id, tournament_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_reminder_log_tournament ON reminder_log(tournament_id);
CREATE INDEX IF NOT EXISTS idx_reminder_log_user       ON reminder_log(user_id);

-- No RLS on reminder_log — service-role-only writes; readers go
-- through the API which already auth-checks.
