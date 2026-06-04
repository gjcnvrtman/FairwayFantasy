// ============================================================
// SHARED TYPESCRIPT TYPES
// ============================================================

export interface League {
  id: string;
  name: string;
  slug: string;
  invite_code: string;
  commissioner_id: string;
  max_players: number;
  created_at: string;
}

export interface Profile {
  id: string;
  display_name: string;
  email: string;
  created_at: string;
}

export interface LeagueMember {
  id: string;
  league_id: string;
  user_id: string;
  role: 'commissioner' | 'member';
  joined_at: string;
  profile?: Profile;
}

export interface Tournament {
  id: string;
  espn_event_id: string;
  name: string;
  type: 'regular' | 'major';
  season: number;
  start_date: string;
  end_date: string;
  pick_deadline: string | null;
  cut_score: number | null;
  status: 'upcoming' | 'active' | 'cut_made' | 'complete';
  course_name: string | null;
}

export interface Golfer {
  id: string;
  espn_id: string;
  datagolf_id: number | null;
  name: string;
  owgr_rank: number | null;
  is_dark_horse: boolean;
  headshot_url: string | null;
  country: string | null;
}

export interface Pick {
  id: string;
  league_id: string;
  tournament_id: string;
  user_id: string;
  // NOT NULL since migration 005 (2026-05-20) — see db/schema.ts.
  golfer_1_id: string;
  golfer_2_id: string;
  golfer_3_id: string;
  golfer_4_id: string;
  is_locked: boolean;
  submitted_at: string;
  // Added strokes at scoring time. Default 0. Set to 2 by the
  // missed-deadline auto-assign sweep (sync.ts:sweepMissedPicks);
  // generic channel reserved for future penalty classes. See
  // migration 002 (2026-06-04).
  penalty_strokes: number;
  // Joined data
  golfer_1?: Golfer;
  golfer_2?: Golfer;
  golfer_3?: Golfer;
  golfer_4?: Golfer;
}

export interface Score {
  id: string;
  tournament_id: string;
  golfer_id: string;
  espn_golfer_id: string;
  round_1: number | null;
  round_2: number | null;
  round_3: number | null;
  round_4: number | null;
  total_strokes: number | null;
  score_to_par: number | null;
  position: string | null;
  status: 'active' | 'missed_cut' | 'withdrawn' | 'disqualified' | 'complete';
  fantasy_score: number | null;
  was_replaced: boolean;
  replaced_by_golfer_id: string | null;
  // Holes completed in the current round (0..18). NULL when ESPN
  // didn't provide it — see scores.holes_played in db/schema.ts.
  holes_played: number | null;
  // Per-hole stroke arrays. NULL when round hasn't been played.
  // Drives the daily-scorecard PDF generator (migration 004).
  round_1_holes: number[] | null;
  round_2_holes: number[] | null;
  round_3_holes: number[] | null;
  round_4_holes: number[] | null;
  last_synced: string;
}

export interface FantasyResult {
  id: string;
  league_id: string;
  tournament_id: string;
  user_id: string;
  golfer_1_score: number | null;
  golfer_2_score: number | null;
  golfer_3_score: number | null;
  golfer_4_score: number | null;
  counting_golfers: number[];
  total_score: number | null;
  rank: number | null;
  updated_at: string;
  // Joined
  profile?: Profile;
  pick?: Pick;
}

export interface SeasonStanding {
  id: string;
  league_id: string;
  user_id: string;
  season: number;
  total_score: number;
  tournaments_played: number;
  best_finish: number | null;
  rank: number | null;
  // Joined
  profile?: Profile;
}

// ESPN API response types
export interface ESPNCompetitor {
  id: string;
  displayName: string;
  shortName: string;
  headshot?: { href: string };
  status: {
    type: { name: string }; // "active", "cut", "wd"
    // `thru` and `currentRound` are present on the /pga/leaderboard
    // payload but absent on the /pga/scoreboard fallback. The
    // normalizer (src/lib/espn.ts) leaves them null when missing so
    // syncTournament can distinguish "no data" from a real zero.
    thru: number | null;
    currentRound: number | null;
  };
  score: { displayValue: string; value: number };
  linescores: Array<{ displayValue: string; value: number }>;
  statistics: Array<{ name: string; displayValue: string }>;
  sortOrder: number;
  // Per-round per-hole strokes, indexed by [round-1][hole-1]. Sparse:
  // a round that hasn't been played is `null`; a round that's in
  // progress is a partial array of length 1..18. Extracted by
  // normalizeScoreboardCompetitor from the scoreboard payload's
  // c.linescores[r].linescores[h].value (ESPN's nested
  // per-round/per-hole structure).
  holesByRound: Array<number[] | null>;
}

export interface ESPNLeaderboard {
  events: Array<{
    id: string;
    name: string;
    shortName: string;
    competitions: Array<{
      id: string;
      status: {
        type: { name: string; completed: boolean };
        period: number;
      };
      competitors: ESPNCompetitor[];
      situation?: { cutLine?: { value: number } };
    }>;
  }>;
}

// ESPN Rankings types (used by rankings sync)
export interface ESPNRankingAthlete {
  id: string;
  displayName: string;
  flag?: { alt?: string };
  headshot?: { href: string };
}

export interface ESPNRankingEntry {
  current: number;
  athlete: ESPNRankingAthlete;
}
