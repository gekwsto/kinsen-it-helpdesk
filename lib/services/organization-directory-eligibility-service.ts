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
 * ⚠ REGRESSION GUARD (enforced by scripts/test-organization-placement-
 * trust-boundary-guard.ts): do NOT use this function's `.eligible` to gate
 * PRIMARY organizational placement in microsoft-department-sync-service.ts
 * (or anywhere else driving setPrimaryDepartmentMembership for an
 * already-authenticated login). That was the exact production bug this
 * guard exists to prevent from recurring — see
 * isOrganizationPlacementTrustedForAuthenticatedLogin below, which is the
 * correct predicate for that decision. This function's userType check is
 * scoped to bulk Directory Sync trust — it stays here, unchanged, for
 * validateDirectoryUser only.
 *
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

export type OrganizationPlacementTrustResult =
  | { trusted: true; matchedEmail: string }
  | { trusted: false; reason: "no_matching_domain" };

/**
 * ⚠ REGRESSION GUARD (enforced by scripts/test-organization-placement-
 * trust-boundary-guard.ts): this is the ONLY function allowed to gate
 * PRIMARY organizational placement (resolveOrganizationPlacement +
 * setPrimaryDepartmentMembership) for an already-authenticated Microsoft
 * login. Do not substitute getOrganizationDirectoryEligibility(...).eligible
 * here — see that function's own guard comment above for why.
 *
 * A DELIBERATELY NARROWER trust question than getOrganizationDirectoryEligibility
 * above — used ONLY by microsoft-department-sync-service.ts's per-login sync
 * to decide whether THIS SPECIFIC LOGIN's Graph companyName/department are
 * trustworthy enough to drive canonical organizational placement
 * (resolveOrganizationPlacement + setPrimaryDepartmentMembership).
 *
 * Root-cause context: the two real callers of getOrganizationDirectoryEligibility
 * are answering two DIFFERENT questions that happened to share one boolean:
 *   - organization-directory-sync-service.ts (the full tenant scan) has NO
 *     admission proof of its own for any of the (up to) thousands of Graph
 *     user records it processes — userType!=="Member" (Guest) exclusion is a
 *     genuinely necessary, irreplaceable defense there: an Entra B2B guest's
 *     `mail` CAN legitimately be shaped like an allowed org domain (see
 *     getOrganizationDirectoryEligibility's own header comment), so domain-
 *     matching ALONE is not sufficient trust for a bulk, unauthenticated scan.
 *   - microsoft-department-sync-service.ts's syncMicrosoftUserDepartment only
 *     ever runs for a user who has ALREADY: (1) successfully completed real
 *     Microsoft OAuth (proving control of Entra credentials for this exact
 *     identity), AND (2) had that identity's email independently checked
 *     against the SAME allowed-domain list at lib/auth.ts's `signIn`
 *     callback, before this code path is ever reached at all. Reusing the
 *     FULL eligibility check (including userType) here meant a real,
 *     already-admitted, domain-valid employee could be denied their
 *     canonical Graph-derived organizational placement — landing with NO
 *     primary department at all — purely because Entra's `userType` for
 *     that specific account happened to read something other than "Member"
 *     (a real, observed condition for some accounts, independent of actual
 *     employment status), even though Graph supplied perfectly usable
 *     `companyName`/`department` values.
 *
 * The fix is NOT to drop the Guest/userType protection — that stays exactly
 * as strict for the Directory Sync, which has no other trust anchor. It is
 * to recognize that for an ALREADY-AUTHENTICATED login, domain-matching
 * (mail-then-userPrincipalName, the exact same precedence and the exact
 * same lib/allowed-email-domains.ts policy) is an INDEPENDENTLY sufficient
 * placement-trust signal on its own — it is the same check `signIn` already
 * enforced to let this user in in the first place. userType is deliberately
 * NOT consulted here.
 *
 * Domain mismatch (a real, hard-fail case — the account's mail/UPN genuinely
 * doesn't belong to an allowed organization domain) still fails closed: no
 * organizational placement, exactly as before.
 */
export function isOrganizationPlacementTrustedForAuthenticatedLogin(
  input: { mail?: string | null; userPrincipalName?: string | null }
): OrganizationPlacementTrustResult {
  const mail = normalizeEmailLike(input.mail);
  if (mail && isAllowedOrganizationEmail(mail)) return { trusted: true, matchedEmail: mail };

  const upn = normalizeEmailLike(input.userPrincipalName);
  if (upn && isAllowedOrganizationEmail(upn)) return { trusted: true, matchedEmail: upn };

  return { trusted: false, reason: "no_matching_domain" };
}
