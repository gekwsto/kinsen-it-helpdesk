/**
 * The single, shared "is this Microsoft/Entra account a real organizational
 * identity" rule — used identically by the full Microsoft Directory Sync
 * (organization-directory-sync-service.ts's validateDirectoryUser) and the
 * per-login Microsoft sync (microsoft-department-sync-service.ts's
 * syncMicrosoftUserDepartment), so a user's ORGANIZATION SYNC eligibility
 * can never silently diverge between the two entry points.
 *
 * Deliberately independent of Company/Department PLACEMENT (see
 * organization-company-department-resolver.ts): this decides WHO
 * participates in organization sync at all; `companyName` decides WHERE an
 * already-eligible user is placed in the tree. A user can be
 * `@kinsen.gr` and belong to `companyName: "Kinsen Austria"` — both true at
 * once, never conflated.
 *
 * Deliberately independent of AUTHENTICATION policy too (lib/auth.ts's
 * `signIn` callback already gates Microsoft SSO to an allowed organization
 * domain before this code ever runs) — this module exists so
 * organization-sync eligibility is correct and self-contained on its own
 * terms, not because it's the only thing standing between an outside
 * account and the app.
 *
 * Reuses the SAME lib/allowed-email-domains.ts policy
 * lib/auth.ts/lib/auth.config.ts already read for the authentication gate —
 * one deployment-wide "what are our real organization domains" setting
 * drives both, never two independently-configurable domain lists that
 * could drift apart. That module supports more than one allowed domain
 * (e.g. "kinsen.gr,saracakis.gr") — everything in this file is written
 * against "any configured allowed domain", never a single assumed one.
 */
import { isAllowedOrganizationEmail } from "@/lib/allowed-email-domains";

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
  if (mail && isAllowedOrganizationEmail(mail)) return { eligible: true, matchedEmail: mail };

  const upn = normalizeEmailLike(input.userPrincipalName);
  if (upn && isAllowedOrganizationEmail(upn)) return { eligible: true, matchedEmail: upn };

  return { eligible: false, reason: "no_matching_domain" };
}

/**
 * The domain portion of an already-validated eligible email — e.g.
 * `extractEligibleDomain(eligibility.matchedEmail)` after
 * `getOrganizationDirectoryEligibility` returned `eligible: true`. This is
 * the ONE place that turns "this user is eligible" into "this is the
 * specific domain they're eligible under" — used by FIND-006's
 * domain-scoped Job Title permission mapping (microsoft-mapping-service.ts)
 * and by the discovery catalog's tenant scan (microsoft-directory-service.ts,
 * for `otherDomainsObserved`) — so both features derive a domain the exact
 * same way, never two slightly different implementations. Deliberately NOT
 * exported as "the current domain" — always call this on a specific
 * matched/observed email, never assume `ALLOWED_ORGANIZATION_EMAIL_DOMAINS`
 * (lib/allowed-email-domains.ts) exhaustively describes every domain that
 * will ever appear here (that list is what's ALLOWED/eligible; this
 * function reads what a specific email ACTUALLY is, including a
 * NON-allowed domain, e.g. for `otherDomainsObserved` visibility) — this is
 * also why an already-multi-domain deployment (kinsen.gr + saracakis.gr)
 * stays correct with zero changes to this function.
 */
export function extractEmailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

/** Convenience boolean-only wrapper for call sites that don't need the reason. */
export function isEligibleOrganizationDirectoryUser(input: OrganizationDirectoryEligibilityInput): boolean {
  return getOrganizationDirectoryEligibility(input).eligible;
}
