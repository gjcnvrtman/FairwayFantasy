// Platform-admin gate. Single canonical email today (Greg). Used to
// hide / refuse capabilities that aren't safe to expose to regular
// users — currently just the per-user "override email" field on the
// Account page, which exists so Greg can route his own recap emails
// to a test inbox without changing his login email.
//
// Case-insensitive match. Trim to be defensive against trailing
// whitespace from the session payload.

const PLATFORM_ADMIN_EMAILS = new Set<string>([
  'gjcnvrtman@gmail.com',
]);

export function isPlatformAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return PLATFORM_ADMIN_EMAILS.has(email.trim().toLowerCase());
}
