// ============================================================
// AUTH VALIDATION — shared client + server registration validator.
// Mirrors the validateCreateLeague pattern: pure function returns
// per-field errors, used by both the form and the API route.
// ============================================================

export const AUTH_LIMITS = {
  DISPLAY_NAME_MIN: 2,
  DISPLAY_NAME_MAX: 40,
  PASSWORD_MIN:     10,
  PASSWORD_MAX:    128,
  // Password must contain at least this many distinct character classes
  // out of: lowercase, uppercase, digit, symbol.
  PASSWORD_MIN_CLASSES: 3,
  // First / last name limits (migration 012). 60 each leaves plenty of
  // room for hyphenated / multi-word real names while keeping the
  // leaderboard parenthetical from blowing out the row.
  NAME_MIN: 1,
  NAME_MAX: 60,
} as const;

// Permissive email regex — RFC 5322 is impractical to enforce
// client-side. The server tries to register and the DB UNIQUE
// constraint on profiles.email handles the rest.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Count distinct character classes present in a password.
 * Classes: lowercase letter, uppercase letter, digit, symbol
 * (anything that's not a-z, A-Z, or 0-9).
 */
export function countPasswordClasses(password: string): number {
  let n = 0;
  if (/[a-z]/.test(password)) n++;
  if (/[A-Z]/.test(password)) n++;
  if (/[0-9]/.test(password)) n++;
  if (/[^a-zA-Z0-9]/.test(password)) n++;
  return n;
}

/**
 * Validate password complexity (length + character classes). Returns
 * an error string when invalid, ``null`` when OK. Shared by
 * registration AND the password-reset flow so the rules can't drift.
 */
export function validatePassword(password: string): string | null {
  if (!password) {
    return 'Password is required.';
  }
  if (password.length < AUTH_LIMITS.PASSWORD_MIN) {
    return `Password must be at least ${AUTH_LIMITS.PASSWORD_MIN} characters.`;
  }
  if (password.length > AUTH_LIMITS.PASSWORD_MAX) {
    return `Password is too long (max ${AUTH_LIMITS.PASSWORD_MAX} characters).`;
  }
  if (countPasswordClasses(password) < AUTH_LIMITS.PASSWORD_MIN_CLASSES) {
    return `Password must contain at least ${AUTH_LIMITS.PASSWORD_MIN_CLASSES} of: lowercase letter, uppercase letter, digit, symbol.`;
  }
  return null;
}

/**
 * Validate a display name (length only). Returns an error string when
 * invalid, ``null`` when OK. Shared by registration AND the in-session
 * profile-edit flow so the rules can't drift.
 */
export function validateDisplayName(name: string): string | null {
  if (!name) {
    return 'Display name is required.';
  }
  if (name.length < AUTH_LIMITS.DISPLAY_NAME_MIN) {
    return `Display name must be at least ${AUTH_LIMITS.DISPLAY_NAME_MIN} characters.`;
  }
  if (name.length > AUTH_LIMITS.DISPLAY_NAME_MAX) {
    return `Display name must be ${AUTH_LIMITS.DISPLAY_NAME_MAX} characters or fewer.`;
  }
  return null;
}

/**
 * Validate a single first/last name field. Returns an error string when
 * invalid, ``null`` when OK. `label` is interpolated into the message so
 * callers can reuse the helper for either field without duplicating the
 * length rules.
 */
export function validateName(value: string, label: 'First name' | 'Last name'): string | null {
  if (!value) {
    return `${label} is required.`;
  }
  if (value.length < AUTH_LIMITS.NAME_MIN) {
    return `${label} must be at least ${AUTH_LIMITS.NAME_MIN} character.`;
  }
  if (value.length > AUTH_LIMITS.NAME_MAX) {
    return `${label} must be ${AUTH_LIMITS.NAME_MAX} characters or fewer.`;
  }
  return null;
}

export function validateRegistration(input: {
  email:        string;
  display_name: string;
  password:     string;
  first_name:   string;
  last_name:    string;
}): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!input.email) {
    errors.email = 'Email is required.';
  } else if (!EMAIL_RE.test(input.email)) {
    errors.email = 'Enter a valid email address.';
  } else if (input.email.length > 254) {
    errors.email = 'Email is too long.';
  }

  const nameError = validateDisplayName(input.display_name);
  if (nameError) errors.display_name = nameError;

  const firstErr = validateName(input.first_name, 'First name');
  if (firstErr) errors.first_name = firstErr;

  const lastErr = validateName(input.last_name, 'Last name');
  if (lastErr) errors.last_name = lastErr;

  const pwError = validatePassword(input.password);
  if (pwError) errors.password = pwError;

  return errors;
}
