/**
 * Single source of truth for "what does this Company/Department name
 * canonically look like" — the org-structure equivalent of
 * lib/services/email-identity.ts's normalizeEmail. Generic and data-driven:
 * trim + collapse internal whitespace + lowercase, nothing tenant-specific
 * (no hardcoded "Kinsen"/"Kinsen Austria"/"Saracakis" special-casing). Every
 * Company/Department create or rename — whether from Microsoft Directory
 * Sync (lib/services/organization-directory-sync-service.ts) or the manual
 * admin CRUD (lib/services/department-service.ts, app/api/admin/companies/**)
 * — must compute this before writing `normalizedName`, so the database-level
 * unique index (Company.normalizedName, Department's
 * @@unique([companyId, normalizedName])) is the real duplicate-prevention
 * backstop, exactly like the User.email lower(email) index — application
 * normalization alone is a convention, not a guarantee.
 */
export function normalizeOrganizationName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Alias kept separate (not just a re-export) so call sites read clearly about which entity they're normalizing — both currently share the exact same rule. */
export const normalizeCompanyName = normalizeOrganizationName;
export const normalizeDepartmentName = normalizeOrganizationName;

/**
 * The single well-known fallback name used when Microsoft Graph doesn't
 * supply a companyName/department for a user — never invented per-call, so
 * every unassigned user always lands in the exact same node rather than a
 * new "Unassigned" row being accidentally created each run (the
 * normalizedName unique index would reject a second one anyway, but using
 * one constant avoids ever relying on that as the mechanism).
 */
export const UNASSIGNED_NODE_NAME = "Unassigned";
