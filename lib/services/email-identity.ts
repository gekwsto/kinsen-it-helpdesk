/**
 * Single source of truth for "what does this email canonically look like"
 * — every User create/lookup path in the app (Microsoft login, admin user
 * creation, inbound email requester resolution, integration requester
 * resolution) must normalize through this function before touching the
 * User table, so "User@Example.com" and "user@example.com" are always
 * treated as the same identity everywhere, not just in whichever code path
 * happened to remember to call .toLowerCase() itself.
 *
 * This alone is still an application-level convention, not a guarantee —
 * the real guarantee is the database-level functional unique index on
 * lower(email) (see the add_user_email_case_insensitive_unique migration),
 * which makes a case-variant duplicate impossible to insert even from a
 * code path that forgets to call this (e.g. a future one, or a raw SQL
 * script). This function exists so that normal, non-colliding usage never
 * even reaches that constraint as an error — lookups find the right row
 * the first time, on every path.
 */
export function normalizeEmail(rawEmail: string): string {
  return rawEmail.trim().toLowerCase();
}
