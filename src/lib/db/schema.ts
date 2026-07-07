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
  // Real-world name. Required at signup (migration 012), nullable for
  // legacy pre-2026-06-12 users until they fill them in via /account
  // or an admin edits them via /api/admin/member-name.
  first_name:           string | null;
  last_name:            string | null;
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
  // 'co_commissioner' added 2026-05-20 (migration 006) — deputy role
  // with operational permissions but no structural authority.
  role:      Generated<'commissioner' | 'co_commissioner' | 'member'>;
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
  // First observation of a non-empty ESPN competitors collection (set
  // by runFieldSync in src/lib/sync.ts). NULL = picks gated.
  field_published_at:      Timestamp | null;
  // Course par per hole (length 0..18). Derived from ESPN's per-hole
  // scoreType.displayValue at sync time: par = strokes - relative.
  // NULL = not yet derived (pre-tee-off). Drives the par row on the
  // daily-scorecard PDF. Migration 006 (2026-06-04).
  par_by_hole:             number[] | null;
  // Per-tournament link to the hand-curated course profile that
  // drives the course-fit prediction. NULL = no profile curated
  // yet; predictor refuses to run for these. Migration 016.
  course_profile_id:       string | null;
  // Soft-delete flag (migration 022). Hidden tournaments never
  // auto-populate into new leagues and never appear in schedule /
  // picks / history views. Toggled TRUE for opposite-field events
  // Greg's leagues don't want (ISCO, Corales Puntacana).
  hidden:                  Generated<boolean>;
  created_at:              Generated<Timestamp>;
}

// ── league_tournaments (migration 022) ───────────────────────
// Per-league schedule. Every row is "this tournament is part of
// this league's schedule." Populated at league creation from the
// global tournaments table (non-hidden, inside the league's date
// window); commissioners add/remove after that on AdminPanel.
export interface LeagueTournamentsTable {
  league_id:      string;
  tournament_id:  string;
  added_by:       string | null;
  added_at:       Generated<Timestamp>;
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
  // NOT NULL since migration 005 (2026-05-20). The app-layer
  // validatePick check already rejected partials at submit time;
  // making the DB column reflect that closes a defense-in-depth gap.
  golfer_1_id:        string;
  golfer_2_id:        string;
  golfer_3_id:        string;
  golfer_4_id:        string;
  golfer_tuple_hash:  ColumnType<string | null, never, never>;
  is_locked:          Generated<boolean>;
  submitted_at:       Generated<Timestamp>;
  // Added strokes applied at scoring time. Default 0. Writer today is
  // the missed-deadline auto-assign sweep (sync.ts:sweepMissedPicks),
  // which sets this to 2 when it auto-generates a lineup for a user
  // who didn't submit by pick_deadline. See migration 002.
  penalty_strokes:    Generated<number>;
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
  // ESPN status.thru — holes completed in the current round (0..18).
  // NULL when ESPN didn't provide it (scoreboard fallback path,
  // pre-tee-off, between rounds with no fresh data). Constrained
  // 0..18 at the DB layer. Added by migration 003 (2026-06-04).
  holes_played:          number | null;
  // Per-hole stroke arrays — one per round, length 0..18.
  // Added by migration 004 (2026-06-04). NULL when round hasn't
  // been played / no data. Extracted from ESPN scoreboard's
  // c.linescores[round-1].linescores[hole-1].value.
  round_1_holes:         number[] | null;
  round_2_holes:         number[] | null;
  round_3_holes:         number[] | null;
  round_4_holes:         number[] | null;
  last_synced:           Generated<Timestamp>;
}

// ── daily_scorecard_log ──────────────────────────────────────
// Dedup marker for the post-round-complete daily scorecard email.
// One row per (league, tournament, round) — the UNIQUE constraint
// blocks double-sends if the detection loop runs multiple times
// after the round-complete condition latches. Migration 005.
export interface DailyScorecardLogTable {
  id:             Generated<string>;
  league_id:      string;
  tournament_id:  string;
  round_num:      number;
  sent_at:        Generated<Timestamp>;
  emails_sent:    Generated<number>;
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
// `email_enabled` gates pick reminders (the only reminder channel
// today). `nightly_recap_enabled` + `tournament_recap_enabled` were
// added in migration 009 (2026-06-06) for the Account page recap
// opt-outs; both default true so existing users keep receiving the
// daily-scorecard + tournament-recap emails unless they explicitly
// toggle off.
export interface ReminderPreferencesTable {
  user_id:                   string;          // PK + FK
  email_enabled:             Generated<boolean>;
  sms_enabled:               Generated<boolean>;
  push_enabled:              Generated<boolean>;
  nightly_recap_enabled:     Generated<boolean>;
  tournament_recap_enabled:  Generated<boolean>;
  // Field-set email: "ESPN published the field, go make your picks."
  // Default TRUE (migration 014). Independent of the other recap
  // toggles AND of email_enabled — the new toggle is the SOLE gate.
  field_published_enabled:   Generated<boolean>;
  hours_before:              Generated<number>;
  email_addr:                string | null;
  phone_e164:                string | null;
  push_token:                string | null;
  updated_at:                Generated<Timestamp>;
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
  league_tournaments:    LeagueTournamentsTable;
  golfers:               GolfersTable;
  picks:                 PicksTable;
  scores:                ScoresTable;
  fantasy_results:       FantasyResultsTable;
  season_standings:      SeasonStandingsTable;
  reminder_preferences:  ReminderPreferencesTable;
  reminder_log:          ReminderLogTable;
  rate_limits:           RateLimitsTable;
  daily_scorecard_log:   DailyScorecardLogTable;
  tournament_recap_log:  TournamentRecapLogTable;
  league_tournament_bets:LeagueTournamentBetsTable;
  league_messages:       LeagueMessagesTable;
  league_broadcasts:     LeagueBroadcastsTable;
  // ── predictions / phase 3 ─────────────────────────────────
  datagolf_tournament_predictions: DatagolfTournamentPredictionsTable;
  course_profiles:                 CourseProfilesTable;
  model_weight_configs:            ModelWeightConfigsTable;
  golfer_stat_snapshots:           GolferStatSnapshotsTable;
  tournament_prediction_runs:      TournamentPredictionRunsTable;
  golfer_predictions:              GolferPredictionsTable;
  foursome_recommendations:        FoursomeRecommendationsTable;
  backtest_runs:                   BacktestRunsTable;
  backtest_results:                BacktestResultsTable;
  bw_courses_cache:                BwCoursesCacheTable;
  bw_course_holes_cache:           BwCourseHolesCacheTable;
}

// ── bw_courses_cache (migration 021) ─────────────────────────
// Local mirror of the boys-weekend Course table; populated by
// scripts/sync-bw-courses.ts. The course-profile form autofills
// physical fields from rows here so we never re-key the data.
export interface BwCoursesCacheTable {
  id:               number;        // boys-weekend Course.id
  name:             string;
  address:          string | null;
  city:             string | null;
  state:            string | null;
  zip:              string | null;
  phone:            string | null;
  website:          string | null;
  tee_time_url:     string | null;
  google_maps_url:  string | null;
  lat:              number | null;
  lng:              number | null;
  rating:           number | null;
  slope:            number | null;
  notes:            string | null;
  active:           Generated<boolean>;
  // Pre-computed roll-ups from CourseHole. Recomputed every sync.
  total_par:        number | null;
  total_yardage:    number | null;
  par_3_count:      number | null;
  par_4_count:      number | null;
  par_5_count:      number | null;
  hole_count:       number | null;
  synced_at:        Generated<Timestamp>;
}

export interface BwCourseHolesCacheTable {
  id:           number;
  course_id:    number;
  hole_number:  number;
  par:          number;
  stroke_index: number | null;
  yardages:     unknown | null;
}

// ── backtest_runs (migration 019) ─────────────────────────────
export interface BacktestRunsTable {
  id:                             Generated<string>;
  weight_config_id:               string;
  tournament_ids:                 string[];
  status:                         Generated<'pending' | 'running' | 'complete' | 'failed'>;
  events_tested:                  number | null;
  events_with_complete_data:      number | null;
  avg_projected_vs_actual:        string | null;
  avg_best_foursome_rank:         string | null;
  pct_beat_league_average:        string | null;
  pct_beat_league_winner:         string | null;
  avg_sleeper_accuracy:           string | null;
  notes:                          string | null;
  triggered_by:                   string | null;
  started_at:                     Generated<Timestamp>;
  completed_at:                   Timestamp | null;
}

// ── backtest_results (migration 019) ──────────────────────────
export interface BacktestResultsTable {
  id:                                 Generated<string>;
  backtest_run_id:                    string;
  tournament_id:                      string;
  prediction_run_id:                  string | null;
  projected_score:                    string | null;
  actual_score:                       string | null;
  best_recommended_rank_in_league:    number | null;
  beat_league_average:                boolean | null;
  beat_league_winner:                 boolean | null;
  avg_finish_recommended:             string | null;
  made_cut_pct:                       string | null;
  top_10_pct:                         string | null;
  top_20_pct:                         string | null;
  total_fantasy_points:               string | null;
  regret_score:                       string | null;
  sleeper_accuracy:                   string | null;
  details:                            unknown | null;
}

// ── course_profiles (migration 016) ──────────────────────────
// Per-tournament hand-curated profile with fantasy-fit fields.
// NUMERIC columns come back as strings via pg.
export interface CourseProfilesTable {
  id:                            Generated<string>;
  external_course_id:            number | null;
  name:                          string;
  total_par:                     number | null;
  total_yardage:                 number | null;
  par_3_count:                   number | null;
  par_4_count:                   number | null;
  par_5_count:                   number | null;
  grass_type:                    string | null;
  scoring_difficulty:            string | null;
  driving_distance_importance:   string | null;
  driving_accuracy_importance:   string | null;
  approach_importance:           string | null;
  around_green_importance:       string | null;
  putting_importance:            string | null;
  birdie_rate:                   string | null;
  bogey_rate:                    string | null;
  comparable_course_ids:         string[] | null;
  notes:                         string | null;
  curated_by:                    string | null;
  curated_at:                    Generated<Timestamp>;
  updated_at:                    Generated<Timestamp>;
}

// ── model_weight_configs (migration 018) ─────────────────────
export interface ModelWeightConfigsTable {
  id:                       Generated<string>;
  name:                     string;
  course_fit_weight:        string;
  recent_form_weight:       string;
  long_term_weight:         string;
  course_history_weight:    string;
  cut_probability_weight:   string;
  upside_weight:            string;
  is_active:                Generated<boolean>;
  description:              string | null;
  created_by:               string | null;
  created_at:               Generated<Timestamp>;
}

// ── golfer_stat_snapshots (migration 017) ────────────────────
export interface GolferStatSnapshotsTable {
  id:                    Generated<string>;
  golfer_id:             string | null;
  golfer_name_raw:       string;
  as_of_date:            string;  // DATE comes back as YYYY-MM-DD string
  source:                Generated<string>;
  sg_total:              string | null;
  sg_ott:                string | null;
  sg_app:                string | null;
  sg_arg:                string | null;
  sg_putt:               string | null;
  driving_distance:      string | null;
  driving_accuracy_pct:  string | null;
  gir_pct:               string | null;
  scoring_avg:           string | null;
  birdie_avg:            string | null;
  bogey_avg:             string | null;
  made_cut_pct:          string | null;
  raw_json:              unknown | null;
  uploaded_by:           string | null;
  uploaded_at:           Generated<Timestamp>;
}

// ── tournament_prediction_runs (migration 019) ───────────────
export interface TournamentPredictionRunsTable {
  id:                             Generated<string>;
  tournament_id:                  string;
  weight_config_id:               string;
  stat_as_of_date:                string | null;
  field_size:                     number | null;
  golfers_with_complete_stats:    number | null;
  golfers_with_missing_stats:     number | null;
  missing_inputs:                 unknown | null;
  status:                         Generated<'pending' | 'running' | 'complete' | 'failed'>;
  error:                          string | null;
  triggered_by:                   string | null;
  started_at:                     Generated<Timestamp>;
  completed_at:                   Timestamp | null;
}

// ── golfer_predictions (migration 019) ───────────────────────
// Composite PK (run_id, golfer_id). No `id`.
export interface GolferPredictionsTable {
  run_id:                     string;
  golfer_id:                  string;
  is_top_tier:                boolean;
  course_fit_score:           string | null;
  recent_form_score:          string | null;
  long_term_score:            string | null;
  course_history_score:       string | null;
  cut_probability_score:      string | null;
  upside_score:               string | null;
  composite_score:            string;
  projected_strokes_to_par:   string | null;
  projected_cut_made_prob:    string | null;
  explanation:                string | null;
}

// ── foursome_recommendations (migration 019) ─────────────────
export interface FoursomeRecommendationsTable {
  id:                       Generated<string>;
  run_id:                   string;
  rank:                     number;
  top_tier_1_golfer_id:     string;
  top_tier_2_golfer_id:     string;
  dark_horse_1_golfer_id:   string;
  dark_horse_2_golfer_id:   string;
  foursome_hash:            string;
  projected_fantasy_score:  string;
  confidence_score:         string;
  risk_level:               'conservative' | 'balanced' | 'aggressive';
  estimated_ownership_pct:  string | null;
  key_strengths:            string[] | null;
  key_concerns:             string[] | null;
  foursome_explanation:     string | null;
}

// ── datagolf_tournament_predictions (migration 020) ──────────
// Local cache of Datagolf's pre-tournament probabilities for the
// upcoming event. Refreshed weekly by fairway-datagolf.timer.
// UNIQUE (tournament_id, datagolf_player_id) makes re-pulls idempotent.
export interface DatagolfTournamentPredictionsTable {
  id:                  Generated<string>;          // UUID
  tournament_id:       string;
  golfer_id:           string | null;               // NULL until matcher links it
  datagolf_player_id:  number;
  player_name_raw:     string;
  pulled_at:           Generated<Timestamp>;
  // All probabilities are normalized to 0..1 at write time.
  win_prob:            string | null;               // NUMERIC(6,5) — pg returns string
  top_5_prob:          string | null;
  top_10_prob:         string | null;
  top_20_prob:         string | null;
  make_cut_prob:       string | null;
  expected_finish:     string | null;
  raw_json:            unknown | null;              // JSONB
}

// ── league_messages (migration 011) ──────────────────────────
// Per-tournament smack board. Each row is one message authored by
// a league member, scoped to (league_id, tournament_id). Hard
// delete by author / commissioner / co_commissioner. No edits —
// posted = posted. Body 1..500 chars (CHECK constraint enforced at
// the DB layer; validator mirrored in src/lib/messages.ts).
export interface LeagueMessagesTable {
  id:             Generated<string>;       // UUID
  league_id:      string;
  tournament_id:  string;
  user_id:        string;
  body:           string;
  created_at:     Generated<Timestamp>;
}

// ── league_broadcasts (migration 013) ─────────────────────────
// Audit log of commissioner / co-commissioner emails sent to every
// member of a league. One row per broadcast, NOT per recipient —
// recipient_count is the snapshot taken at send time.
export interface LeagueBroadcastsTable {
  id:               Generated<string>;
  league_id:        string;
  sender_user_id:   string;
  subject:          string;
  body:             string;
  recipient_count:  number;
  sent_at:          Generated<Timestamp>;
}

// ── league_tournament_bets (migration 010) ───────────────────
// Per-(league, tournament) bet override. The league-wide
// `leagues.weekly_bet_amount` is the league's default; an entry
// here overrides it for one tournament inside one league only.
// Missing row = use the league default at read time.
// Commissioner-editable on `upcoming` tournaments only.
export interface LeagueTournamentBetsTable {
  league_id:      string;        // PK part 1
  tournament_id:  string;        // PK part 2
  bet_amount:     string;        // NUMERIC(10,2) — pg returns string for precision
  updated_at:     Generated<Timestamp>;
}

// ── tournament_recap_log (migration 009) ─────────────────────
// One row per (league, tournament) — the UNIQUE constraint blocks
// double-sends when the detection loop runs after a tournament's
// status flips to 'complete'. Mirror of DailyScorecardLogTable
// without the round_num column.
export interface TournamentRecapLogTable {
  id:             Generated<string>;
  league_id:      string;
  tournament_id:  string;
  sent_at:        Generated<Timestamp>;
  emails_sent:    Generated<number>;
}
