/**
 * The set of email domains whose Microsoft/Entra accounts belong to this
 * organization — the single shared source of truth for:
 *  - Microsoft SSO login gating (lib/auth.ts's `signIn` callback,
 *    lib/auth.config.ts's `authorized` callback — the latter runs in the
 *    Edge runtime, which is why this module has ZERO dependencies: no
 *    Prisma, no Node-only APIs, safe to import from either runtime)
 *  - Organization sync eligibility
 *    (lib/services/organization-directory-eligibility-service.ts, and
 *    everything built on top of it: full directory sync, per-login
 *    department/job-title sync, domain-scoped mapping validation)
 *
 * Configured via `ALLOWED_EMAIL_DOMAIN` — historically a single domain
 * string (e.g. "kinsen.gr"). Now also accepts a comma-separated list
 * (e.g. "kinsen.gr,saracakis.gr") so a deployment can allow more than one
 * organization domain with a single env var change, no code change. A bare
 * single value keeps working exactly as before (it's just a one-element
 * list) — this is purely additive. Falls back to `["kinsen.gr"]` if the
 * variable is entirely unset, matching this app's original default.
 */

function parseDomainList(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const domain = part.trim().toLowerCase();
    if (domain.length > 0) seen.add(domain);
  }
  return Array.from(seen);
}

const configured = parseDomainList(process.env.ALLOWED_EMAIL_DOMAIN);

/** Every configured organization domain, lowercase, deduplicated, in configured order. Never empty. */
export const ALLOWED_ORGANIZATION_EMAIL_DOMAINS: readonly string[] =
  configured.length > 0 ? configured : ["kinsen.gr"];

function normalizeEmailLike(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Exact "@domain" suffix match on the FULL normalized string against ANY
 * configured allowed domain — a strict boundary check, never a loose
 * substring search:
 *   - "user@fakesaracakis.gr" -> false (the character immediately before
 *     "saracakis.gr" is "e", not "@" — no such suffix exists).
 *   - "user@saracakis.gr.fake.com" -> false (the string doesn't end there
 *     at all).
 * `String.endsWith` on the whole string IS a correct email-domain-boundary
 * check by construction — no custom parsing/regex needed. Case-insensitive
 * (input is lowercased before comparison).
 */
export function isAllowedOrganizationEmail(email: string | null | undefined): boolean {
  const normalized = normalizeEmailLike(email);
  if (!normalized) return false;
  return ALLOWED_ORGANIZATION_EMAIL_DOMAINS.some((domain) => normalized.endsWith(`@${domain}`));
}

/**
 * The specific configured allowed domain an email matched (or null if
 * none did) — used wherever a caller needs to know WHICH of possibly
 * several allowed domains this identity belongs to (e.g. to tag a
 * domain-scoped MicrosoftDepartmentMapping/MicrosoftDirectoryJobTitleValue
 * row with the user's REAL domain, never a single assumed one).
 */
export function getAllowedOrganizationEmailDomain(email: string | null | undefined): string | null {
  const normalized = normalizeEmailLike(email);
  if (!normalized) return null;
  return ALLOWED_ORGANIZATION_EMAIL_DOMAINS.find((domain) => normalized.endsWith(`@${domain}`)) ?? null;
}
