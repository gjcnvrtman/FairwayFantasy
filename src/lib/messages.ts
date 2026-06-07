// ============================================================
// LEAGUE-MESSAGES validators / shared shapes for the smack board.
// Kept pure (no DB, no Next imports) so vitest can drive it without
// pulling pg into the test bundle. Mirrors the auth-validation /
// auth-decisions / scoring split used elsewhere in this repo.
// ============================================================

export const MESSAGE_LIMITS = {
  BODY_MIN: 1,
  BODY_MAX: 500,
  // Soft cap on what a single GET returns. We render newest-first and
  // page resets per tournament, so 100 is plenty of room for a week
  // of trash talk even in a large league.
  PAGE_SIZE: 100,
  // Per-user posting rate limit. Loose enough that a flame war
  // breathes; tight enough that a runaway bot or stuck-key user
  // can't dump 10k rows.
  POST_LIMIT: 20,
  POST_WINDOW_SECONDS: 600,  // 10 minutes
} as const;

/**
 * Validate a smack-board message body. Returns an error string when
 * invalid, ``null`` when OK. Trim before calling — the route does so.
 */
export function validateMessageBody(body: string): string | null {
  if (!body) {
    return 'Message can\'t be empty.';
  }
  if (body.length < MESSAGE_LIMITS.BODY_MIN) {
    return 'Message can\'t be empty.';
  }
  if (body.length > MESSAGE_LIMITS.BODY_MAX) {
    return `Message must be ${MESSAGE_LIMITS.BODY_MAX} characters or fewer.`;
  }
  return null;
}

/**
 * Shape returned by GET /api/leagues/[slug]/messages. Joined view —
 * the author's display_name is denormalized into the row at read
 * time so the client doesn't need a second roundtrip. ``canDelete``
 * is computed server-side per-message per-viewer (author OR
 * commissioner OR co_commissioner).
 */
export interface MessageView {
  id:           string;
  user_id:      string;
  display_name: string;
  body:         string;
  created_at:   string;
  canDelete:    boolean;
}
