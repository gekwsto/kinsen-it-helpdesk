/**
 * Orchestrates Microsoft Graph-based department sync during login. Called
 * once, from lib/auth.ts's jwt callback, on Microsoft sign-in only — never
 * on page renders, API requests, or workspace switches.
 *
 * Always called with an explicit `userId` resolved fresh by the caller for
 * *this* sign-in (see lib/auth.ts, which uses the id Auth.js's own adapter
 * just created/resolved — never a session/token-cached id) — this function
 * never reads a user id from anywhere else, so it works identically for a
 * brand-new user's first login and a returning user's Nth login.
 */
import { GlobalRoleSource, MembershipSource, Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  resolveDepartmentMemberships,
  hasActiveProfileDepartmentMapping,
  resolvePrimaryMicrosoftMapping,
} from "@/lib/services/microsoft-mapping-service";
import { syncDepartmentMemberships, setPrimaryDepartmentMembership, isPrimaryCompanySqlGeneralAuthoritative } from "@/lib/services/department-membership-service";
import { resolveDefaultGlobalRoleAssignment, resolveDefaultDepartmentRoleAssignment } from "@/lib/services/default-role-service";
import { fetchMicrosoftGraphProfile, type GraphUserProfile } from "@/lib/services/microsoft-graph-profile-service";
import { maybeAutoCreateDepartmentForGraphValue } from "@/lib/services/microsoft-department-autocreate-service";
import { shouldSyncGlobalRole } from "@/lib/services/department-role-translation";
import { upsertDiscoveredMicrosoftDirectoryValue } from "@/lib/services/microsoft-directory-service";
import { syncMicrosoftProfilePhoto } from "@/lib/services/microsoft-profile-photo-service";
import { getOrganizationDirectoryEligibility, isOrganizationPlacementTrustedForAuthenticatedLogin, extractEmailDomain } from "@/lib/services/organization-directory-eligibility-service";
import { createOrganizationResolutionCache, resolveOrganizationPlacement } from "@/lib/services/organization-company-department-resolver";
import { enqueueOrRecoverSqlGeneralUserSync } from "@/lib/services/sqlgeneral-user-sync-service";
import { isSqlGeneralPrimaryPlacementEnabled } from "@/lib/sqlgeneral-api-client";
import type { MicrosoftIdentityClaims } from "@/types/department";

export interface SyncMicrosoftUserDepartmentParams {
  /** Delegated access token from this sign-in's OAuth exchange — never persisted, never logged. */
  accessToken?: string;
  userId: string;
  oid: string;
  email: string;
  name?: string | null;
  /** Entra groups/roles, if ever populated by an ID-token claim — passed through untouched; Graph is not queried for these. */
  fallbackGroups?: string[];
  fallbackRoles?: string[];
}

/**
 * Builds MicrosoftIdentityClaims from a fetched Graph profile. Pure and
 * side-effect free — exported specifically so the Graph-profile -> identity
 * -signals mapping can be unit tested without any network or DB access.
 */
export function buildClaimsFromGraphProfile(
  base: {
    oid: string;
    email: string;
    name?: string | null;
    fallbackGroups?: string[];
    fallbackRoles?: string[];
  },
  profile: GraphUserProfile
): MicrosoftIdentityClaims {
  return {
    oid: base.oid,
    email: base.email,
    name: base.name,
    department: profile.department ?? null,
    jobTitle: profile.jobTitle ?? null,
    companyName: profile.companyName ?? null,
    userType: profile.userType ?? null,
    groups: base.fallbackGroups,
    roles: base.fallbackRoles,
  };
}

/**
 * Fetches the signed-in user's department from Microsoft Graph and syncs
 * SECONDARY DepartmentMembership rows (explicit admin-configured
 * group/app-role/job-title/profile-department mappings) from it.
 *
 * PRIMARY Company/Department placement is a ROLLOUT-GATED hand-off, not an
 * unconditional removal (REQUIRED: "preserve existing Microsoft placement
 * behavior while SQLGeneral primary authority is disabled; new authority
 * must activate only through an explicit rollout gate"):
 *   - isSqlGeneralPrimaryPlacementEnabled() === false (the default, and the
 *     state immediately after this round's code deploys): Microsoft keeps
 *     setting PRIMARY placement exactly as it always did — same resolver,
 *     same setPrimaryDepartmentMembership call, same companyId write —
 *     so a brand-new hire still gets a real workspace on their first login
 *     even though SQLGeneral isn't live yet. No accidental access
 *     regression immediately after deployment.
 *   - isSqlGeneralPrimaryPlacementEnabled() === true (after an admin
 *     deliberately flips the SAME flag the SQLGeneral worker itself checks
 *     — one flag, one rollout moment, never two independently-toggleable
 *     switches that could disagree): Microsoft stops touching PRIMARY
 *     placement at all — that authority now belongs to SQLGeneral
 *     (applySqlGeneralPrimaryPlacement) or an explicit MANUAL admin edit —
 *     and this function only syncs unrelated Graph profile fields
 *     (name/jobTitle/organizationSyncedAt).
 * Either way, once a user's current active primary is SQLGeneral-sourced
 * (isPrimaryCompanySqlGeneralAuthoritative), Microsoft NEVER overwrites
 * User.companyId for them again — including on a SUBSEQUENT login after a
 * rollout flag rollback — SQLGeneral's verified Company is never clobbered
 * once it has become authoritative for a given user (REQUIRED: resolve the
 * User.companyId dual-writer precedence).
 *

 * Failure handling: if the Graph call fails for any reason (missing/expired
 * token, 401/403/429, 5xx, network/timeout, malformed response), this logs a
 * safe warning and returns WITHOUT calling resolveDepartmentMemberships or
 * syncDepartmentMemberships — sign-in continues and existing memberships
 * (MANUAL or Microsoft-derived) are left completely untouched. This is
 * deliberately different from a *successful* call that returns an empty/null
 * department, which is a legitimate signal and is allowed to flow through
 * the normal sync (which correctly drops a department membership whose
 * source signal disappeared) — collapsing those two cases would let a
 * transient Graph outage wipe out real memberships, which must never happen.
 *
 * If the Graph department has no active PROFILE_DEPARTMENT mapping, and
 * AUTO_CREATE_GRAPH_DEPARTMENTS=true, a Department + default mapping is
 * created on the fly (see microsoft-department-autocreate-service.ts) — an
 * explicit mapping, when one exists, is always checked first and always
 * wins; auto-create is never even considered otherwise.
 */
export async function syncMicrosoftUserDepartment(
  params: SyncMicrosoftUserDepartmentParams
): Promise<void> {
  const { accessToken, userId, oid, email, name, fallbackGroups, fallbackRoles } = params;

  const result = await fetchMicrosoftGraphProfile(accessToken);

  // SQLGeneral Organization Sync enqueue/recovery — deliberately right here,
  // regardless of whether the REST of this function's department sync
  // succeeds below, and BEFORE the early return on a failed Graph call. The
  // delegated access token behind this exact call is short-lived and never
  // persisted, so onPremisesSamAccountName can only ever be captured from
  // THIS live result — see enqueueOrRecoverSqlGeneralUserSync's own doc
  // comment. Never throws, never blocks or slows down login beyond this
  // best-effort write.
  await enqueueOrRecoverSqlGeneralUserSync(userId, result.ok ? result.profile.onPremisesSamAccountName : null);

  if (!result.ok) {
    console.warn("[microsoft-department-sync] Graph profile fetch failed, skipping sync this login", {
      email,
      userId,
      reason: result.reason,
      status: result.status,
    });
    return;
  }

  const claims = buildClaimsFromGraphProfile({ oid, email, name, fallbackGroups, fallbackRoles }, result.profile);

  // Computed FIRST, before the opportunistic cache-fill below — this
  // user's own eligible domain (one of possibly several allowed
  // organization domains, see lib/allowed-email-domains.ts) is needed for
  // BOTH the job-title cache fill and the SECONDARY MicrosoftDepartmentMapping
  // resolution below, so it's derived exactly once and reused, never
  // guessed or re-derived per call site.
  //
  // `result.profile.mail` first (this call's own GET /me fetch); falls back
  // to `claims.email` (the email lib/auth.ts's signIn callback already
  // gated to an allowed organization domain for this exact signed-in user,
  // before this function ever ran) whenever Graph's own `mail` is EITHER
  // absent OR an empty string — `||`, not `??`: a real, observed Graph
  // response shape for some accounts is `mail: ""` (not null), which `??`
  // does NOT treat as "absent," so the intended fallback silently never
  // fired for those accounts, leaving a perfectly valid, already-verified
  // session email unused. Same "mail can legitimately be unusable for a
  // real account, fall back to another trustworthy identity" pattern
  // already used elsewhere in this codebase (e.g. validateDirectoryUser's
  // own mail-then-userPrincipalName fallback).
  const effectiveMail = result.profile.mail || claims.email;

  // getOrganizationDirectoryEligibility is used here ONLY for its
  // userType-inclusive "is this a real tenant Member" signal, feeding the
  // job-title cache fill / domain-scoped PROFILE_JOB_TITLE SECONDARY
  // mapping below — NOT for the PRIMARY placement gate anymore (see
  // isOrganizationPlacementTrustedForAuthenticatedLogin below and its own
  // doc comment for the full root-cause reasoning: this function answers a
  // genuinely different question than "should THIS authenticated login's
  // real Graph company/department drive canonical placement").
  const eligibility = getOrganizationDirectoryEligibility({
    userType: claims.userType,
    mail: effectiveMail,
    userPrincipalName: result.profile.userPrincipalName,
  });
  // FIND-006: the SAME matched domain that gates the job-title cache fill
  // AND the (secondary-membership/global-role) MicrosoftDepartmentMapping
  // resolution further down — a domain-scoped PROFILE_JOB_TITLE mapping
  // can only ever match/cache under the exact domain eligibility already
  // confirmed, never re-derived or guessed separately. null when not
  // eligible at all — buildCandidates (microsoft-mapping-service.ts) then
  // simply never builds a PROFILE_JOB_TITLE candidate for this login,
  // exactly like "no eligible domain" should behave.
  const eligibleDomain = eligibility.eligible ? extractEmailDomain(eligibility.matchedEmail) : null;

  // Organizational placement (PRIMARY department) — FIND-003
  // (docs/roadmap-handoff-register.md), refined by the userType/eligibility
  // decoupling fix above: uses the exact same organization-company-
  // department-resolver.ts multi-company Company/Department resolution the
  // full Directory Sync uses (never a second, independent department-
  // resolution mechanism) — so a full sync and a first Microsoft login for
  // the same Graph profile converge on the identical organizational
  // placement. Gated on placementTrust (domain match ONLY — see that
  // function's own doc comment for why userType is deliberately NOT
  // reconsidered here, unlike `eligibility` above): a genuinely
  // non-allowed-domain account is skipped entirely — no company/department
  // resolution, no primary membership change, existing data left exactly
  // as-is.
  const placementTrust = isOrganizationPlacementTrustedForAuthenticatedLogin({
    mail: effectiveMail,
    userPrincipalName: result.profile.userPrincipalName,
  });

  // Opportunistic cache fill (Operation A side-effect — see
  // microsoft-directory-service.ts header comment): zero extra Graph calls,
  // zero extra permissions, independent of whether any mapping matches.
  if (claims.department) await upsertDiscoveredMicrosoftDirectoryValue("department", claims.department);
  if (claims.jobTitle) await upsertDiscoveredMicrosoftDirectoryValue("jobTitle", claims.jobTitle, eligibleDomain);

  let primaryDepartmentSynced = false;
  if (placementTrust.trusted) {
    // Two independent reasons Microsoft may NOT place this user's PRIMARY
    // this run, combined into one decision so the "which branch runs" logic
    // never duplicates the profile-fields-only write path:
    //   - the rollout gate is ON (isSqlGeneralPrimaryPlacementEnabled) —
    //     SQLGeneral/MANUAL are the only paths, by design (REQUIRED).
    //   - SQLGeneral has ALREADY become authoritative for this SPECIFIC
    //     user's Company (isPrimaryCompanySqlGeneralAuthoritative) — even
    //     while the gate is currently OFF (a rollback: flipped on long
    //     enough to place this user, then off again). Checked as a whole
    //     "skip the entire placement attempt," not just the companyId
    //     field — REQUIRED: "Microsoft must not overwrite its verified
    //     company, including on subsequent syncs," and a half-skip
    //     (dropping only companyId while still letting
    //     setPrimaryDepartmentMembership move the primary DEPARTMENT to
    //     whatever Microsoft resolved, and still creating an orphan local
    //     Company/Department as a side effect) would reintroduce the exact
    //     inconsistency this guard exists to prevent.
    const sqlGeneralIsAuthoritative = await isPrimaryCompanySqlGeneralAuthoritative(userId);
    const microsoftShouldPlacePrimary = !isSqlGeneralPrimaryPlacementEnabled() && !sqlGeneralIsAuthoritative;

    if (microsoftShouldPlacePrimary) {
      // Reinstates Microsoft's original PRIMARY placement behavior
      // byte-for-byte, so this round's code can deploy with zero
      // access-regression risk before anyone opts in to SQLGeneral
      // authority (REQUIRED: "preserve existing Microsoft placement
      // behavior while SQLGeneral primary authority is disabled").
      try {
        const placementCache = createOrganizationResolutionCache();
        const placement = await resolveOrganizationPlacement(placementCache, claims.companyName, claims.department);
        // REQUIRED (unresolved-Microsoft-directory-data safety round): an
        // unresolved Company (placement.companyId === null from a
        // non-blank, unmatched signal) or a Department that fell back to
        // the Unassigned bucket is degraded/untrusted information — it
        // must never downgrade an EXISTING user's already-good placement.
        // Read once, reused for both guards below; User.companyId/
        // departmentId are the canonical mirrors of the user's current
        // placement, so a non-null value here reliably means "there is
        // something real to protect." Safe to apply unconditionally for a
        // brand-new user (nothing to protect yet) — same as before.
        const existingPlacement = await prisma.user.findUnique({ where: { id: userId }, select: { companyId: true, departmentId: true } });
        const unresolvedCompanyWouldClobber = placement.companyId === null && existingPlacement?.companyId != null;
        await prisma.user.update({
          where: { id: userId },
          data: {
            ...(unresolvedCompanyWouldClobber ? {} : { companyId: placement.companyId }),
            givenName: result.profile.givenName ?? undefined,
            surname: result.profile.surname ?? undefined,
            jobTitle: claims.jobTitle ?? undefined,
            organizationSyncedAt: new Date(),
          },
        });
        const unresolvedDepartmentWouldClobber = placement.departmentFellBackToUnassigned && existingPlacement?.departmentId != null;
        if (!unresolvedDepartmentWouldClobber) {
          const departmentDefault = await resolveDefaultDepartmentRoleAssignment();
          await setPrimaryDepartmentMembership(userId, placement.departmentId, MembershipSource.MICROSOFT_DEPARTMENT, {
            role: departmentDefault.role,
            customRoleId: departmentDefault.customRoleId,
            deactivateObsoleteAutomaticPrimary: true,
          });
          primaryDepartmentSynced = true;
        }
      } catch (err) {
        console.warn("[microsoft-department-sync] Failed to resolve/set organization placement", {
          userId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      // Either the rollout gate is on, or SQLGeneral already owns this
      // user's Company — either way, this function only syncs unrelated
      // Graph profile fields, never companyId/departmentId/isPrimary, and
      // never even calls resolveOrganizationPlacement (so no orphan local
      // Company/Department is created as a side effect either).
      try {
        await prisma.user.update({
          where: { id: userId },
          data: {
            givenName: result.profile.givenName ?? undefined,
            surname: result.profile.surname ?? undefined,
            jobTitle: claims.jobTitle ?? undefined,
            organizationSyncedAt: new Date(),
          },
        });
      } catch (err) {
        console.warn("[microsoft-department-sync] Failed to sync profile fields", {
          userId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // SECONDARY memberships — the existing, unchanged MicrosoftDepartmentMapping
  // resolution (group/app-role/job-title/profile-department admin-configured
  // mappings). Never touches an isPrimary row (syncDepartmentMemberships's
  // own header comment) — independent of primary placement, which this
  // function no longer performs at all.
  let resolved = await resolveDepartmentMemberships(claims, eligibleDomain);

  if (claims.department) {
    const hasMapping = await hasActiveProfileDepartmentMapping(claims.department);
    if (!hasMapping) {
      const autoCreated = await maybeAutoCreateDepartmentForGraphValue(claims.department);
      if (autoCreated) resolved = [...resolved, autoCreated];
    }
  }

  // autoPromoteSoleActiveMembership: false (REQUIRED, DO #2) — a purely
  // SECONDARY MicrosoftDepartmentMapping match (e.g. an org-wide Entra
  // group grant) must NEVER be silently promoted to isPrimary — that would
  // grant real workspace access before this user's first verified
  // SQLGeneral placement, exactly the loophole workspace-service.ts's
  // resolveActiveWorkspace also closes on the read side. Primary placement
  // is SQLGeneral's (or an explicit MANUAL admin edit's) job only now —
  // this function performs none of its own.
  await syncDepartmentMemberships(userId, resolved, { autoPromoteSoleActiveMembership: false });

  // Global role sync: a SEPARATE, independent mapping-priority decision
  // (lib/services/microsoft-mapping-service.ts) — unrelated to the
  // organization-placement resolution above (which is now driven entirely
  // by organization-company-department-resolver.ts's companyName/department
  // signal, not MicrosoftDepartmentMapping) — unless a manual override or
  // System Admin status protects them (shouldSyncGlobalRole). Completely
  // independent of the primary department placement above (no `department`
  // connect here anymore).
  const primaryMapping = await resolvePrimaryMicrosoftMapping(claims, eligibleDomain);
  const globalRoleUpdate: Prisma.UserUpdateInput = { lastMicrosoftSyncAt: new Date() };
  let globalRoleSynced = false;
  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, customRoleId: true, globalRoleSource: true },
  });
  if (primaryMapping) {
    if (dbUser && shouldSyncGlobalRole(dbUser)) {
      // primaryMapping.role IS the global Role directly now (a previous
      // phase moved MicrosoftDepartmentMapping.role from DepartmentRole to
      // Role) — no translation needed here, unlike DepartmentMembership's
      // role below in resolveDepartmentMemberships, which still needs the
      // reverse translation since DepartmentMembership.role stays DepartmentRole.
      globalRoleUpdate.role = primaryMapping.role;
      // Custom GLOBAL/BOTH-scope role this mapping grants instead of the
      // built-in `role` above, or null for a plain built-in mapping — see
      // MicrosoftDepartmentMapping.globalCustomRoleId's schema comment.
      // Always written (never left stale): this sync fully owns
      // User.customRoleId once shouldSyncGlobalRole() allows it, exactly as
      // it already fully owns User.role — a user's PREVIOUS Microsoft-synced
      // custom role must be cleared if the winning mapping is now a
      // built-in-only one, same as `role` itself is always overwritten
      // rather than left stale.
      globalRoleUpdate.customRole = primaryMapping.globalCustomRoleId
        ? { connect: { id: primaryMapping.globalCustomRoleId } }
        : { disconnect: true };
      globalRoleUpdate.globalRoleSource = "MICROSOFT_DEPARTMENT";
      globalRoleUpdate.globalRoleUpdatedAt = new Date();
      globalRoleUpdate.globalRoleMicrosoftMapping = { connect: { id: primaryMapping.id } };
      globalRoleSynced = true;
    }
  } else if (
    dbUser &&
    dbUser.customRoleId === null &&
    dbUser.globalRoleSource === GlobalRoleSource.SYSTEM &&
    shouldSyncGlobalRole(dbUser)
  ) {
    // No explicit mapping matched — the "configured Default Global Role"
    // tier (lib/services/default-role-service.ts) applies ONLY to a user
    // whose global role has genuinely never been set (customRoleId still
    // null AND globalRoleSource still the untouched SYSTEM default — never
    // MANUAL or MICROSOFT_DEPARTMENT-from-a-now-stale-mapping, both of
    // which are an "existing" assignment rule #1 protects). Re-applying
    // this on every subsequent no-mapping login is intentional and
    // idempotent — it lets an admin changing the configured default
    // propagate to still-never-assigned users going forward, and is a
    // true no-op once applied (customRoleId becomes non-null, so this
    // branch never re-enters for that user again unless a later mapping
    // match or an admin's MANUAL edit changes globalRoleSource first).
    const globalDefault = await resolveDefaultGlobalRoleAssignment();
    if (globalDefault.customRoleId) {
      globalRoleUpdate.role = globalDefault.role;
      globalRoleUpdate.customRole = { connect: { id: globalDefault.customRoleId } };
      globalRoleUpdate.globalRoleSource = GlobalRoleSource.SYSTEM;
      globalRoleUpdate.globalRoleUpdatedAt = new Date();
      globalRoleSynced = true;
    }
  }
  await prisma.user.update({ where: { id: userId }, data: globalRoleUpdate });

  console.log("[microsoft-department-sync] Synced department membership from Graph", {
    email,
    userId,
    departmentPresent: claims.department !== null,
    resolvedCount: resolved.length,
    // organizationPlacementTrusted gates BOTH branches above (full
    // placement when the rollout gate is off, profile-fields-only when
    // it's on — see this function's own header comment);
    // directorySyncStyleEligible (userType-inclusive) stays
    // visibility/diagnostics only.
    organizationPlacementTrusted: placementTrust.trusted,
    directorySyncStyleEligible: eligibility.eligible,
    primaryDepartmentSynced,
    globalRoleSynced,
  });
}

/** The subset of User fields the jwt callback needs — before AND after sync. */
export type SyncEligibleDbUser = {
  id: string;
  role: Role;
  isActive: boolean;
  mustChangePassword: boolean;
  departmentId: string | null;
  businessUnitId: string | null;
  customRoleId: string | null;
  microsoftUserId: string | null;
  globalRoleSource: GlobalRoleSource;
  name: string | null;
  image: string | null;
};

/** Single source of truth for the fields lib/auth.ts must select — reused there directly so the two never drift apart. */
export const SYNC_ELIGIBLE_USER_SELECT = {
  id: true,
  role: true,
  isActive: true,
  mustChangePassword: true,
  departmentId: true,
  businessUnitId: true,
  customRoleId: true,
  microsoftUserId: true,
  globalRoleSource: true,
  name: true,
  image: true,
} as const;

export interface HandleMicrosoftJwtSignInParams {
  /** Pre-sync row, exactly as read by lib/auth.ts before this call. */
  dbUser: SyncEligibleDbUser;
  accessToken?: string;
  oid?: string;
  providerAccountId: string;
  userEmail: string;
  userName?: string | null;
  fallbackGroups?: string[];
  fallbackRoles?: string[];
}

/**
 * The whole Microsoft sign-in branch of the jwt callback, extracted so it's
 * independently testable and so lib/auth.ts has exactly one place it reads
 * user fields from to build the token — this function's RETURN VALUE, never
 * the pre-sync `dbUser` it was called with.
 *
 * This is the fix for a real bug: the caller used to assign token fields
 * from the pre-sync row and only afterward call the sync, so a brand-new
 * user's first-login token/session shipped with the stale default role
 * (e.g. "User") even though the database was updated correctly — it just
 * self-corrected on the next login when a fresh row was read. By awaiting
 * profile backfill + syncMicrosoftUserDepartment + a refetch here, and
 * having the caller assign token fields from what THIS function returns,
 * the token is built from post-sync data on the very first login. No
 * fire-and-forget anywhere in this chain — every step is awaited in order.
 */
export async function handleMicrosoftJwtSignIn(
  params: HandleMicrosoftJwtSignInParams
): Promise<SyncEligibleDbUser> {
  const { dbUser, accessToken, oid, providerAccountId, userEmail, userName, fallbackGroups, fallbackRoles } = params;

  console.log("[auth] microsoft jwt sign-in started", {
    userId: dbUser.id,
    accessTokenPresent: !!accessToken,
    oidPresent: !!oid,
  });

  const profileUpdate: { microsoftUserId?: string; name?: string } = {};
  if (oid && dbUser.microsoftUserId !== oid) profileUpdate.microsoftUserId = oid;
  // Backfill only — never overwrite an existing (possibly admin-set) name.
  if (!dbUser.name && userName) profileUpdate.name = userName;
  if (Object.keys(profileUpdate).length > 0) {
    await prisma.user.update({ where: { id: dbUser.id }, data: profileUpdate });
  }

  console.log("[auth] microsoft jwt sign-in sync starting", { userId: dbUser.id });
  await syncMicrosoftUserDepartment({
    accessToken,
    userId: dbUser.id,
    oid: oid ?? providerAccountId,
    email: userEmail,
    name: userName,
    fallbackGroups,
    fallbackRoles,
  });

  // Runs for EVERY Microsoft sign-in — new user or existing, no branching
  // needed here (see lib/services/microsoft-profile-photo-service.ts's own
  // header comment for why). Never throws, never blocks/fails sign-in — a
  // Graph failure here just means this login's photo check is skipped.
  const photoResult = await syncMicrosoftProfilePhoto({ userId: dbUser.id, accessToken });
  if (!photoResult.ok) {
    console.warn("[auth] microsoft jwt sign-in photo sync skipped", {
      userId: dbUser.id,
      reason: photoResult.reason,
      status: photoResult.status,
    });
  } else if (photoResult.updated) {
    console.log("[auth] microsoft jwt sign-in photo sync updated", { userId: dbUser.id });
  }

  // Deliberately NO organization/manager Graph call happens during login.
  // `GET /users/{id}/manager` does not support Application permissions at
  // all (see lib/services/organization-manager-sync-service.ts's header
  // comment for the full Graph-contract explanation) — an earlier version
  // of this code path made exactly that unsupported call here, bounded to
  // 5 seconds, which would have failed against a real tenant on every
  // single login. `managerId` is read from the local, already-synchronized
  // organization snapshot wherever it's needed (e.g.
  // lib/services/organization-tree-service.ts's getOrganizationContext,
  // called on demand by GET /api/organization/me) — never fetched live at
  // sign-in time. If that snapshot is stale or missing for this user, it's
  // surfaced as `syncStatus: "NEVER_SYNCED"` there, computed purely from
  // `organizationSyncedAt`/`managerId` being null — nothing to refresh here.
  // Freshening it is the job of the existing, separate, admin-triggered
  // `RELATIONSHIP_REFRESH` sync (lib/services/organization-sync-orchestrator.ts),
  // never an implicit side effect of a user logging in.

  // The critical step: read back what sync just wrote, so the caller builds
  // the token from fresh data instead of the pre-sync snapshot above.
  const refreshed = await prisma.user.findUnique({
    where: { id: dbUser.id },
    select: SYNC_ELIGIBLE_USER_SELECT,
  });

  console.log("[auth] microsoft jwt sign-in sync completed", {
    userId: dbUser.id,
    role: refreshed?.role ?? dbUser.role,
    departmentId: refreshed?.departmentId ?? dbUser.departmentId,
    globalRoleSource: refreshed?.globalRoleSource ?? dbUser.globalRoleSource,
    photoUpdated: photoResult.ok && photoResult.updated,
  });

  // refreshed should always be non-null (we just wrote to this exact row) —
  // the fallback is only for the theoretical case it vanished mid-request,
  // and it deliberately falls back to the pre-sync `dbUser` rather than
  // inventing data, never silently promoting/crashing either way.
  return refreshed ?? dbUser;
}
