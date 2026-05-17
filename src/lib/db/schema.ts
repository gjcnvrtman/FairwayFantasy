// ============================================================
// DATABASE SCHEMA TYPES — hand-written, mirrors supabase/schema.sql
//
// Why hand-written rather than codegen:
//   We're spinning up local Postgres anyway in Phase 3, and the
//   schema is small + stable (10 tables). A codegen toolchain would
//   be overhead we'd just rip out. Single source of truth lives in
//   `supabase/schema.sql`; if you change it, change here too.
//
// Conventions:
//   - `Selectable<T>` produces "what comes out of a SELECT" — all
//     columns including auto-generated ones.
//   - `Insertable<T>` produces "what goes into an INSERT" — auto-gen
//     columns become optional, generated-as columns disappear.
//   - `Updateable<T>` produces "what goes into an UPDATE" — every
//     column becomes optional.
//
// Use kysely's helper types: `Generated<T>` for server-defaulted
// columns, `ColumnType<T, I, U>` for finer control.
// ============================================================

import type { ColumnType, Generated } from 'kysely';

/** ISO 8601 string. Postgres TIMESTAMPTZ comes back as ISO string
 *  via node-postgres unless types.setTypeParser is configured. */
export type Timestamp = string;

/** Postgres returns INT[] as `number[]`. */
export type IntArray = number[];

// ── leagues ──────────────────────────────────────────────────
export interface LeaguesTable {
  id:              Generated<string>;       // UUID
  name:            string;
  slug:            string;
  invite_code:     string;
  commissioner_id: string | null;            // UUID FK (nullable per schema)
  max_players:     Generated<number>;
  // Tournament-eligibility window. Tournaments with start_date inside
  // [start_date, end_date] are the "in-range" set used for picks,
  // dashboard, and money math. Nullable so legacy leagues created
  // before this column landed default to "no filter" (caller treats
  // null as unbounded on either side).
  start_date:      Timestamp | null;
  end_date:        Timestamp | null;
  // Per-tournament stake in dollars. Each non-winner pays this to
  // the (collective) winner; on ties the pot splits evenly.
  weekly_bet_amount: Generated<string>;     // NUMERIC(10,2) — pg returns string for precision
  created_at:      Generated<Timestamp>;
}

// ── profiles ─────────────────────────────────────────────────
// Self-host (Phase 3): no FK to auth.users — Fairway runs its own
// auth via NextAuth Credentials. `id` is generated when the row is
// created (signup) so it stays a UUID like before.
export interface ProfilesTable {
  id:                   Generated<string>;   // UUID, auto-gen on insert
  display_name:         string;
  email:                string;
  created_at:           Generated<Timestamp>;
}

// ── auth_credentials ─────────────────────────────────────────
// Separated from profiles so password material isn't pulled into
// every profile read. Populated at Phase-5 cutover from Supabase
// auth.users; new signups (Phase-4 NextAuth) write here directly.
export interface AuthCredentialsTable {
  user_id:              string;              // PK + FK → profiles.id

  password_hash:        string;              // bcrypt cost ≥ 10

  // Verification — does NOT gate login (UI banner only). SMTP-gated.
  email_verified:       Generated<boolean>;
  verify_token:         string | null;
  verify_token_expires: Timestamp | null;

  // Password reset flow — same SMTP dependency.
  reset_token:          string | null;
  reset_token_expires:  Timestamp | null;

  last_login_at:        Timestamp | null;
  created_at:           Generated<Timestamp>;
  updated_at:           Generated<Timestamp>;
}

// ── league_members ───────────────────────────────────────────
export interface LeagueMembersTable {
  id:        Generated<string>;
  league_id: string;
  user_id:   string;
  role:      Generated<'commissioner' | 'member'>;
  joined_at: Generated<Timestamp>;
}

// ── tournaments ──────────────────────────────────────────────
export interface TournamentsTable {
  id:                      Generated<string>;
  espn_event_id:           string;
  name:                    string;
  type:                    Generated<'regular' | 'major'>;
  season:                  number;
  start_date:              Timestamp;
  end_date:                Timestamp;
  pick_deadline:           Timestamp | null;
  // Commissioner override — when set, takes precedence over pick_deadline.
  pick_deadline_override:  Timestamp | null;
  cut_score:               number | null;
  status:                  Generated<'upcoming' | 'active' | 'cut_made' | 'complete'>;
  course_name:             string | null;
  created_at:              Generated<Timestamp>;
}

// ── golfers ──────────────────────────────────────────────────
// `is_dark_horse` is GENERATED ALWAYS AS (owgr_rank > 24) STORED
// — so it's selectable but never insertable/updateable.
export interface GolfersTable {
  id:            Generated<string>;
  espn_id:       string;
  datagolf_id:   number | null;
  name:          string;
  owgr_rank:     number | null;
  is_dark_horse: ColumnType<boolean | null, never, never>;
  headshot_url:  string | null;
  country:       string | null;
  updated_at:    Generated<Timestamp>;
}

// ── picks ────────────────────────────────────────────────────
// `golfer_tuple_hash` is maintained by a BEFORE INSERT/UPDATE trigger
// (see infra/postgres/init/00-schema.sql) — selectable but app code
// must never write it, hence ColumnType<..., never, never> (same
// pattern as golfers.is_dark_horse).
export interface PicksTable {
  id:                 Generated<string>;
  league_id:          string;
  tournament_id:      string;
  user_id:            string;
  golfer_1_id:        string | null;
  golfer_2_id:        string | null;
  golfer_3_id:        string | null;
  golfer_4_id:        string | null;
  golfer_tuple_hash:  ColumnType<string | null, never, never>;
  is_locked:          Generated<boolean>;
  submitted_at:       Generated<Timestamp>;
}

// ── scores ───────────────────────────────────────────────────
export interface ScoresTable {
  id:                    Generated<string>;
  tournament_id:         string;
  golfer_id:             string;
  espn_golfer_id:        string;
  round_1:               number | null;
  round_2:               number | null;
  round_3:               number | null;
  round_4:               number | null;
  total_strokes:         number | null;
  score_to_par:          number | null;
  position:              string | null;
  status:                Generated<'active' | 'missed_cut' | 'withdrawn' | 'disqualified' | 'complete'>;
  fantasy_score:         number | null;
  was_replaced:          Generated<boolean>;
  replaced_by_golfer_id: string | null;
  last_synced:           Generated<Timestamp>;
}

// ── fantasy_results ──────────────────────────────────────────
export interface FantasyResultsTable {
  id:                Generated<string>;
  league_id:         string;
  tournament_id:     string;
  user_id:           string;
  golfer_1_score:    number | null;
  golfer_2_score:    number | null;
  golfer_3_score:    number | null;
  golfer_4_score:    number | null;
  counting_golfers:  IntArray | null;
  total_score:       number | null;
  rank:              number | null;
  updated_at:        Generated<Timestamp>;
}

// ── season_standings ─────────────────────────────────────────
export interface SeasonStandingsTable {
  id:                  Generated<string>;
  league_id:           string;
  user_id:             string;
  season:              number;
  total_score:         Generated<number>;
  tournaments_played:  Generated<number>;
  best_finish:         number | null;
  rank:                number | null;
  updated_at:          Generated<Timestamp>;
}

// ── reminder_preferences (P9) ────────────────────────────────
export interface ReminderPreferencesTable {
  user_id:        string;          // PK + FK
  email_enabled:  Generated<boolean>;
  sms_enabled:    Generated<boolean>;
  push_enabled:   Generated<boolean>;
  hours_before:   Generated<number>;
  email_addr:     string | null;
  phone_e164:     string | null;
  push_token:     string | null;
  updated_at:     Generated<Timestamp>;
}

// ── reminder_log (P9) ────────────────────────────────────────
export interface ReminderLogTable {
  id:             Generated<string>;
  user_id:        string;
  league_id:      string;
  tournament_id:  string;
  channel:        'email' | 'sms' | 'push' | 'console';
  status:         'console' | 'sent' | 'failed' | 'skipped';
  error_message:  string | null;
  sent_at:        Generated<Timestamp>;
}

// ── rate_limits (per-IP throttling, P0 hardening 2026-05-15) ────
export interface RateLimitsTable {
  key:           string;
  window_start:  Generated<Timestamp>;
  count:         Generated<number>;
  updated_at:    Generated<Timestamp>;
}

// ── Database surface ─────────────────────────────────────────
export interface Database {
  leagues:               LeaguesTable;
  profiles:              ProfilesTable;
  auth_credentials:      AuthCredentialsTable;
  league_members:        LeagueMembersTable;
  tournaments:           TournamentsTable;
  golfers:               GolfersTable;
  picks:                 PicksTable;
  scores:                ScoresTable;
  fantasy_results:       FantasyResultsTable;
  season_standings:      SeasonStandingsTable;
  reminder_preferences:  ReminderPreferencesTable;
  reminder_log:          ReminderLogTable;
  rate_limits:           RateLimitsTable;
}
