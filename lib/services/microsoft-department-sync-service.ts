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
import { DepartmentRole, GlobalRoleSource, MembershipSource, Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  resolveDepartmentMemberships,
  hasActiveProfileDepartmentMapping,
  resolvePrimaryMicrosoftMapping,
} from "@/lib/services/microsoft-mapping-service";
import { syncDepartmentMemberships, setPrimaryDepartmentMembership } from "@/lib/services/department-membership-service";
import { fetchMicrosoftGraphProfile, type GraphUserProfile } from "@/lib/services/microsoft-graph-profile-service";
import { maybeAutoCreateDepartmentForGraphValue } from "@/lib/services/microsoft-department-autocreate-service";
import { shouldSyncGlobalRole } from "@/lib/services/department-role-translation";
import { upsertDiscoveredMicrosoftDirectoryValue } from "@/lib/services/microsoft-directory-service";
import { syncMicrosoftProfilePhoto } from "@/lib/services/microsoft-profile-photo-service";
import { getOrganizationDirectoryEligibility } from "@/lib/services/organization-directory-eligibility-service";
import { createOrganizationResolutionCache, resolveOrganizationPlacement } from "@/lib/services/organization-company-department-resolver";
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
 * Fetches the signed-in user's department from Microsoft Graph and syncs it
 * into DepartmentMembership via the existing resolve/sync services.
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

  // Opportunistic cache fill (Operation A side-effect — see
  // microsoft-directory-service.ts header comment): zero extra Graph calls,
  // zero extra permissions, independent of whether any mapping matches.
  if (claims.department) await upsertDiscoveredMicrosoftDirectoryValue("department", claims.department);
  if (claims.jobTitle) await upsertDiscoveredMicrosoftDirectoryValue("jobTitle", claims.jobTitle);

  // Organizational placement (PRIMARY department) — FIND-003
  // (docs/roadmap-handoff-register.md): uses the exact same
  // organization-directory-eligibility-service.ts rule AND the same
  // organization-company-department-resolver.ts multi-company
  // Company/Department resolution the full Directory Sync uses (never a
  // second, independent department-resolution mechanism) — so a full sync
  // and a first Microsoft login for the same Graph profile converge on the
  // identical organizational placement. Gated on eligibility: a non-Kinsen
  // or Guest account (in practice, close to unreachable here at all — see
  // lib/auth.ts's own `signIn` callback, which already blocks Microsoft SSO
  // outside `@<ALLOWED_EMAIL_DOMAIN>` before this code ever runs — this
  // check exists for its own correctness/defense-in-depth, not because it's
  // the only gate) is skipped entirely: no company/department resolution,
  // no primary membership change, existing data left exactly as-is.
  //
  // Runs BEFORE the SECONDARY MicrosoftDepartmentMapping resolution below —
  // deliberately, not incidentally: syncDepartmentMemberships's own tail
  // fallback ("exactly one active membership and none flagged primary ->
  // promote it") would otherwise auto-promote a plain secondary-mapping
  // membership to primary for a brand-new user, which setPrimaryDepartmentMembership
  // would then immediately have to un-do (treating it as an "obsolete
  // Microsoft-owned primary" from a different department and deactivating
  // it) — a real transient-then-corrected bug this ordering avoids
  // entirely. Same order the full Directory Sync already uses.
  //
  // UNCONDITIONAL relative to shouldSyncGlobalRole — department placement
  // and global role synchronization are deliberately independent decisions
  // (see the User/Department/Member canonical-membership architecture): a
  // manually promoted ADMIN, or any user with globalRoleSource MANUAL,
  // keeps their role exactly as an admin set it (see the global-role block
  // below, unchanged), but their primary organizational department still
  // tracks Microsoft's signal correctly. Role protection ≠ department
  // placement protection. setPrimaryDepartmentMembership is itself the ONLY
  // function allowed to write User.departmentId (see its own header
  // comment) and already protects a MANUAL primary from being silently
  // replaced by an automated sync signal — no separate guard needed here.
  const eligibility = getOrganizationDirectoryEligibility({
    userType: claims.userType,
    // `result.profile.mail` first (this call's own GET /me fetch); falls
    // back to `claims.email` (the email lib/auth.ts's signIn callback
    // already gated to `@<ALLOWED_EMAIL_DOMAIN>` for this exact signed-in
    // user, before this function ever ran) only when Graph's own `mail` is
    // null — the same "mail can legitimately be null for a real account,
    // fall back to another trustworthy identity" pattern already used
    // throughout this codebase (e.g. validateDirectoryUser's own
    // mail-then-userPrincipalName fallback), not a special case invented
    // just for this check.
    mail: result.profile.mail ?? claims.email,
    userPrincipalName: result.profile.userPrincipalName,
  });
  let primaryDepartmentSynced = false;
  if (eligibility.eligible) {
    try {
      const placementCache = createOrganizationResolutionCache();
      const placement = await resolveOrganizationPlacement(placementCache, claims.companyName, claims.department);
      await prisma.user.update({
        where: { id: userId },
        data: {
          companyId: placement.companyId,
          givenName: result.profile.givenName ?? undefined,
          surname: result.profile.surname ?? undefined,
          jobTitle: claims.jobTitle ?? undefined,
          organizationSyncedAt: new Date(),
        },
      });
      await setPrimaryDepartmentMembership(userId, placement.departmentId, MembershipSource.MICROSOFT_DEPARTMENT, {
        role: DepartmentRole.REQUESTER,
        deactivateObsoleteMicrosoftPrimary: true,
      });
      primaryDepartmentSynced = true;
    } catch (err) {
      console.warn("[microsoft-department-sync] Failed to resolve/set organization placement", {
        userId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // SECONDARY memberships — the existing, unchanged MicrosoftDepartmentMapping
  // resolution (group/app-role/job-title/profile-department admin-configured
  // mappings). setPrimaryDepartmentMembership above never creates a row here
  // (it uses the resolver-created department, not a MicrosoftDepartmentMapping
  // lookup), and syncDepartmentMemberships never touches an isPrimary row
  // (see its own header comment) — the two are fully independent from this
  // point on.
  let resolved = await resolveDepartmentMemberships(claims);

  if (claims.department) {
    const hasMapping = await hasActiveProfileDepartmentMapping(claims.department);
    if (!hasMapping) {
      const autoCreated = await maybeAutoCreateDepartmentForGraphValue(claims.department);
      if (autoCreated) resolved = [...resolved, autoCreated];
    }
  }

  await syncDepartmentMemberships(userId, resolved);

  // Global role sync: a SEPARATE, independent mapping-priority decision
  // (lib/services/microsoft-mapping-service.ts) — unrelated to the
  // organization-placement resolution above (which is now driven entirely
  // by organization-company-department-resolver.ts's companyName/department
  // signal, not MicrosoftDepartmentMapping) — unless a manual override or
  // System Admin status protects them (shouldSyncGlobalRole). Completely
  // independent of the primary department placement above (no `department`
  // connect here anymore).
  const primaryMapping = await resolvePrimaryMicrosoftMapping(claims);
  const globalRoleUpdate: Prisma.UserUpdateInput = { lastMicrosoftSyncAt: new Date() };
  let globalRoleSynced = false;
  if (primaryMapping) {
    const dbUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, globalRoleSource: true },
    });
    if (dbUser && shouldSyncGlobalRole(dbUser)) {
      // primaryMapping.role IS the global Role directly now (a previous
      // phase moved MicrosoftDepartmentMapping.role from DepartmentRole to
      // Role) — no translation needed here, unlike DepartmentMembership's
      // role below in resolveDepartmentMemberships, which still needs the
      // reverse translation since DepartmentMembership.role stays DepartmentRole.
      globalRoleUpdate.role = primaryMapping.role;
      globalRoleUpdate.globalRoleSource = "MICROSOFT_DEPARTMENT";
      globalRoleUpdate.globalRoleUpdatedAt = new Date();
      globalRoleUpdate.globalRoleMicrosoftMapping = { connect: { id: primaryMapping.id } };
      globalRoleSynced = true;
    }
  }
  await prisma.user.update({ where: { id: userId }, data: globalRoleUpdate });

  console.log("[microsoft-department-sync] Synced department membership from Graph", {
    email,
    userId,
    departmentPresent: claims.department !== null,
    resolvedCount: resolved.length,
    organizationSyncEligible: eligibility.eligible,
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
