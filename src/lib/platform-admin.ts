// Platform-admin gate. Two canonical emails today: Greg + MJ. Used
// to hide / refuse capabilities that aren't safe to expose to
// regular users:
//   - the per-user "override email" field on the Account page (Greg
//     uses this to route his own recap emails to a test inbox without
//     changing his login email)
//   - the /predictions admin surface (Phase 3, course-fit predictor
//     + lineup recommender + backtest UI)
//
// Case-insensitive match. Trim to be defensive against trailing
// whitespace from the session payload.

const PLATFORM_ADMIN_EMAILS = new Set<string>([
  'gjcnvrtman@gmail.com',
  'jonesmg4@gmail.com',
]);

export function isPlatformAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return PLATFORM_ADMIN_EMAILS.has(email.trim().toLowerCase());
}
