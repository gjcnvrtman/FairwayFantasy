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

export function validateRegistration(input: {
  email:        string;
  display_name: string;
  password:     string;
}): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!input.email) {
    errors.email = 'Email is required.';
  } else if (!EMAIL_RE.test(input.email)) {
    errors.email = 'Enter a valid email address.';
  } else if (input.email.length > 254) {
    errors.email = 'Email is too long.';
  }

  if (!input.display_name) {
    errors.display_name = 'Display name is required.';
  } else if (input.display_name.length < AUTH_LIMITS.DISPLAY_NAME_MIN) {
    errors.display_name = `Display name must be at least ${AUTH_LIMITS.DISPLAY_NAME_MIN} characters.`;
  } else if (input.display_name.length > AUTH_LIMITS.DISPLAY_NAME_MAX) {
    errors.display_name = `Display name must be ${AUTH_LIMITS.DISPLAY_NAME_MAX} characters or fewer.`;
  }

  if (!input.password) {
    errors.password = 'Password is required.';
  } else if (input.password.length < AUTH_LIMITS.PASSWORD_MIN) {
    errors.password = `Password must be at least ${AUTH_LIMITS.PASSWORD_MIN} characters.`;
  } else if (input.password.length > AUTH_LIMITS.PASSWORD_MAX) {
    errors.password = `Password is too long (max ${AUTH_LIMITS.PASSWORD_MAX} characters).`;
  } else if (countPasswordClasses(input.password) < AUTH_LIMITS.PASSWORD_MIN_CLASSES) {
    errors.password = `Password must contain at least ${AUTH_LIMITS.PASSWORD_MIN_CLASSES} of: lowercase letter, uppercase letter, digit, symbol.`;
  }

  return errors;
}
