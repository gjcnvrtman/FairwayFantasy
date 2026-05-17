// ─────────────────────────────────────────────────────────────
// SHARED VALIDATION
// Pure functions (no DB, no env) so they're testable in isolation
// AND callable from both the client form and the server API route.
// ─────────────────────────────────────────────────────────────

export const LEAGUE_LIMITS = {
  NAME_MIN:        3,
  NAME_MAX:        60,
  SLUG_MIN:        2,
  SLUG_MAX:        40,
  MAX_PLAYERS_MIN: 4,
  MAX_PLAYERS_MAX: 50,
  MAX_PLAYERS_DEFAULT: 20,
  BET_MIN:         0,         // free leagues allowed
  BET_MAX:         1_000,     // sanity cap on stakes per tournament
  BET_DEFAULT:     10,
} as const;

const SLUG_RE = /^[a-z0-9-]+$/;
// ISO-date prefix (yyyy-mm-dd) — the <input type="date"> form value.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface CreateLeagueInput {
  name:        string;
  slug:        string;
  maxPlayers:  number;
  /** Tournament window start, ISO-8601 (yyyy-mm-dd). Required. */
  startDate:   string;
  /** Tournament window end, ISO-8601 (yyyy-mm-dd). Required. Must be ≥ startDate. */
  endDate:     string;
  /** Per-tournament stake in dollars. Default $10. Free leagues allowed (0). */
  weeklyBetAmount: number;
}

export interface FieldErrors {
  name?:            string;
  slug?:            string;
  maxPlayers?:      string;
  startDate?:       string;
  endDate?:         string;
  weeklyBetAmount?: string;
  /** Cross-cutting issues that aren't tied to a single field. */
  general?:         string;
}

/**
 * Validate a create-league submission. Returns an object whose keys
 * are field names mapped to user-facing error messages. An empty
 * object means the input is valid.
 *
 * Uniqueness (slug already taken) is intentionally NOT checked here
 * — that requires a DB call and lives in the API route.
 */
export function validateCreateLeague(input: CreateLeagueInput): FieldErrors {
  const errors: FieldErrors = {};
  const { name, slug, maxPlayers, startDate, endDate, weeklyBetAmount } = input;

  // ── name ──
  const trimmedName = (name ?? '').trim();
  if (!trimmedName) {
    errors.name = 'League name is required.';
  } else if (trimmedName.length < LEAGUE_LIMITS.NAME_MIN) {
    errors.name = `League name must be at least ${LEAGUE_LIMITS.NAME_MIN} characters.`;
  } else if (trimmedName.length > LEAGUE_LIMITS.NAME_MAX) {
    errors.name = `League name must be ${LEAGUE_LIMITS.NAME_MAX} characters or fewer.`;
  }

  // ── slug ──
  const slugStr = (slug ?? '').trim();
  if (!slugStr) {
    errors.slug = 'League URL slug is required.';
  } else if (slugStr.length < LEAGUE_LIMITS.SLUG_MIN) {
    errors.slug = `URL slug must be at least ${LEAGUE_LIMITS.SLUG_MIN} characters.`;
  } else if (slugStr.length > LEAGUE_LIMITS.SLUG_MAX) {
    errors.slug = `URL slug must be ${LEAGUE_LIMITS.SLUG_MAX} characters or fewer.`;
  } else if (!SLUG_RE.test(slugStr)) {
    errors.slug = 'URL slug can only contain lowercase letters, numbers, and hyphens.';
  } else if (slugStr.startsWith('-') || slugStr.endsWith('-')) {
    errors.slug = 'URL slug cannot start or end with a hyphen.';
  } else if (slugStr.includes('--')) {
    errors.slug = 'URL slug cannot contain consecutive hyphens.';
  }

  // ── max_players ──
  if (typeof maxPlayers !== 'number' || !Number.isFinite(maxPlayers) || !Number.isInteger(maxPlayers)) {
    errors.maxPlayers = 'Max players must be a whole number.';
  } else if (maxPlayers < LEAGUE_LIMITS.MAX_PLAYERS_MIN) {
    errors.maxPlayers = `Max players must be at least ${LEAGUE_LIMITS.MAX_PLAYERS_MIN}.`;
  } else if (maxPlayers > LEAGUE_LIMITS.MAX_PLAYERS_MAX) {
    errors.maxPlayers = `Max players must be ${LEAGUE_LIMITS.MAX_PLAYERS_MAX} or fewer.`;
  }

  // ── startDate / endDate ──
  // Both required and well-formed before we can compare them; only
  // emit the cross-cutting "end must be after start" error if both
  // sides parsed cleanly.
  let startParsed: Date | null = null;
  let endParsed:   Date | null = null;
  if (!startDate || typeof startDate !== 'string' || !ISO_DATE_RE.test(startDate)) {
    errors.startDate = 'Start date is required (YYYY-MM-DD).';
  } else {
    const d = new Date(startDate + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) errors.startDate = 'Invalid start date.';
    else startParsed = d;
  }
  if (!endDate || typeof endDate !== 'string' || !ISO_DATE_RE.test(endDate)) {
    errors.endDate = 'End date is required (YYYY-MM-DD).';
  } else {
    const d = new Date(endDate + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) errors.endDate = 'Invalid end date.';
    else endParsed = d;
  }
  if (startParsed && endParsed && endParsed.getTime() < startParsed.getTime()) {
    errors.endDate = 'End date must be on or after start date.';
  }

  // ── weekly_bet_amount ──
  if (typeof weeklyBetAmount !== 'number' || !Number.isFinite(weeklyBetAmount)) {
    errors.weeklyBetAmount = 'Weekly bet amount must be a number.';
  } else if (weeklyBetAmount < LEAGUE_LIMITS.BET_MIN) {
    errors.weeklyBetAmount = `Weekly bet amount cannot be negative.`;
  } else if (weeklyBetAmount > LEAGUE_LIMITS.BET_MAX) {
    errors.weeklyBetAmount = `Weekly bet amount cannot exceed $${LEAGUE_LIMITS.BET_MAX}.`;
  } else if (Math.round(weeklyBetAmount * 100) !== weeklyBetAmount * 100) {
    errors.weeklyBetAmount = 'Weekly bet amount cannot have more than 2 decimal places.';
  }

  return errors;
}

/**
 * Derive a URL-safe slug from a free-form league name.
 * Used by the create form to suggest a slug as the user types.
 *  - lowercase
 *  - replace any run of non-alphanumeric chars with a single hyphen
 *  - trim leading/trailing hyphens
 *  - cap at the schema length limit
 */
export function deriveSlugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LEAGUE_LIMITS.SLUG_MAX);
}
