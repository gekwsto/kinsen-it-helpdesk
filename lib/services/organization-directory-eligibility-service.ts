/**
 * The single, shared "is this Microsoft/Entra account a real Kinsen
 * organizational identity" rule — used identically by the full Microsoft
 * Directory Sync (organization-directory-sync-service.ts's
 * validateDirectoryUser) and the per-login Microsoft sync
 * (microsoft-department-sync-service.ts's syncMicrosoftUserDepartment), so
 * a user's ORGANIZATION SYNC eligibility can never silently diverge between
 * the two entry points.
 *
 * Deliberately independent of Company/Department PLACEMENT (see
 * organization-company-department-resolver.ts): this decides WHO
 * participates in organization sync at all; `companyName` decides WHERE an
 * already-eligible user is placed in the tree. A user can be
 * `@kinsen.gr` and belong to `companyName: "Kinsen Austria"` — both true at
 * once, never conflated.
 *
 * Deliberately independent of AUTHENTICATION policy too (lib/auth.ts's
 * `signIn` callback already gates Microsoft SSO to `@<ALLOWED_EMAIL_DOMAIN>`
 * before this code ever runs) — this module exists so organization-sync
 * eligibility is correct and self-contained on its own terms, not because
 * it's the only thing standing between a non-Kinsen account and the app.
 *
 * Reuses the SAME `ALLOWED_EMAIL_DOMAIN` environment variable
 * lib/auth.ts/lib/auth.config.ts already read for the authentication gate —
 * one deployment-wide "what is our real domain" setting drives both,
 * never two independently-configurable domains that could drift apart.
 */

// Exported so other Microsoft-sync features that need the SAME configured
// domain (e.g. lib/services/microsoft-job-title-directory-service.ts's
// domain-scoped Job Title discovery) read it from here rather than
// re-deriving it from process.env themselves — one source of truth.
export const ORGANIZATION_SYNC_ALLOWED_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN?.trim().toLowerCase() || "kinsen.gr");

export interface OrganizationDirectoryEligibilityInput {
  /** Entra `userType` — "Member" or "Guest" (or occasionally absent/other for some tenants). */
  userType?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
}

export type OrganizationDirectoryIneligibleReason = "not_member" | "no_matching_domain";

export type OrganizationDirectoryEligibilityResult =
  | { eligible: true; matchedEmail: string }
  | { eligible: false; reason: OrganizationDirectoryIneligibleReason };

function normalizeEmailLike(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Exact "@domain" suffix match on the FULL normalized string — a strict
 * boundary check, never a loose substring search. `String.endsWith` is
 * already correct for both adversarial shapes this must reject:
 *   - "user@fakekinsen.gr".endsWith("@kinsen.gr") -> false (the character
 *     immediately before "kinsen.gr" is "e", not "@" — no such suffix exists).
 *   - "user@kinsen.gr.evil.com".endsWith("@kinsen.gr") -> false (the string
 *     doesn't end there at all).
 * No custom parsing/regex needed — a suffix check on the whole string IS a
 * correct email-domain-boundary check by construction.
 */
function hasAllowedDomainSuffix(normalizedEmail: string): boolean {
  return normalizedEmail.endsWith(`@${ORGANIZATION_SYNC_ALLOWED_DOMAIN}`);
}

/**
 * The full eligibility decision, with a machine-readable reason when
 * ineligible — callers that need distinct counters (e.g. "skipped: guest"
 * vs "skipped: wrong domain") should branch on `.reason`, never re-derive it.
 *
 * Precedence: userType is checked first — a Guest is never eligible
 * regardless of what domain their `mail` happens to be in (an external
 * collaborator's mail can legitimately be `@kinsen.gr`-shaped in some
 * tenant configurations; that alone must never grant organizational
 * placement). Domain is checked second: `mail` OR `userPrincipalName`,
 * either one matching is sufficient — see this module's header comment for
 * why both are checked (a real Kinsen employee's UPN may still be on the
 * tenant's default `.onmicrosoft.com` suffix while their real `mail` is
 * `@kinsen.gr`, or vice versa).
 */
export function getOrganizationDirectoryEligibility(
  input: OrganizationDirectoryEligibilityInput
): OrganizationDirectoryEligibilityResult {
  if (input.userType && input.userType !== "Member") {
    return { eligible: false, reason: "not_member" };
  }

  const mail = normalizeEmailLike(input.mail);
  if (mail && hasAllowedDomainSuffix(mail)) return { eligible: true, matchedEmail: mail };

  const upn = normalizeEmailLike(input.userPrincipalName);
  if (upn && hasAllowedDomainSuffix(upn)) return { eligible: true, matchedEmail: upn };

  return { eligible: false, reason: "no_matching_domain" };
}

/** Convenience boolean-only wrapper for call sites that don't need the reason. */
export function isEligibleOrganizationDirectoryUser(input: OrganizationDirectoryEligibilityInput): boolean {
  return getOrganizationDirectoryEligibility(input).eligible;
}
