// ============================================================
// PICK DEADLINE — single source of truth for "when do picks lock?"
//
// The rankings sync sets tournaments.pick_deadline = start_date - 1h
// from ESPN's reported start_date. That's often wrong — ESPN reports
// the tournament "day" which can be 6+ hours before the first tee
// time. Commissioners can override per tournament via
// tournaments.pick_deadline_override; when set it takes precedence.
//
// Use effectivePickDeadline() at every read site (the API, the picks
// page, the league dashboard) so there's no chance of one place
// honoring the override and another not.
// ============================================================

export interface PickDeadlineFields {
  pick_deadline:           Date | string | null;
  pick_deadline_override?: Date | string | null;
}

/**
 * Return the deadline that's actually enforced for this tournament,
 * preferring the commissioner override when present.
 */
export function effectivePickDeadline(t: PickDeadlineFields): Date | null {
  const raw = t.pick_deadline_override ?? t.pick_deadline;
  if (!raw) return null;
  return raw instanceof Date ? raw : new Date(raw);
}

/**
 * Convenience: has the deadline passed?
 */
export function isPickDeadlinePassed(t: PickDeadlineFields, now: Date = new Date()): boolean {
  const d = effectivePickDeadline(t);
  return d !== null && now > d;
}
