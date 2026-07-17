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
import { GlobalRoleSource, Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  resolveDepartmentMemberships,
  hasActiveProfileDepartmentMapping,
  resolvePrimaryMicrosoftMapping,
} from "@/lib/services/microsoft-mapping-service";
import { syncDepartmentMemberships } from "@/lib/services/department-membership-service";
import { fetchMicrosoftGraphProfile, type GraphUserProfile } from "@/lib/services/microsoft-graph-profile-service";
import { maybeAutoCreateDepartmentForGraphValue } from "@/lib/services/microsoft-department-autocreate-service";
import { translateDepartmentRoleToGlobalRole, shouldSyncGlobalRole } from "@/lib/services/department-role-translation";
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
  let resolved = await resolveDepartmentMemberships(claims);

  if (claims.department) {
    const hasMapping = await hasActiveProfileDepartmentMapping(claims.department);
    if (!hasMapping) {
      const autoCreated = await maybeAutoCreateDepartmentForGraphValue(claims.department);
      if (autoCreated) resolved = [...resolved, autoCreated];
    }
  }

  await syncDepartmentMemberships(userId, resolved);

  // Global role sync: the SAME mapping that resolved a department signal
  // also decides the user's global Role, unless a manual override or
  // System Admin status protects them (shouldSyncGlobalRole). This is a
  // separate lookup from resolveDepartmentMemberships above (which is
  // per-department and unmodified) because the global role must be one
  // decision, not one per matched department.
  const globalRoleUpdate: Prisma.UserUpdateInput = { lastMicrosoftSyncAt: new Date() };
  const primaryMapping = await resolvePrimaryMicrosoftMapping(claims);
  let globalRoleSynced = false;
  if (primaryMapping) {
    const dbUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, globalRoleSource: true },
    });
    if (dbUser && shouldSyncGlobalRole(dbUser)) {
      globalRoleUpdate.role = translateDepartmentRoleToGlobalRole(primaryMapping.role);
      globalRoleUpdate.department = { connect: { id: primaryMapping.departmentId } };
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
  userImage?: string | null;
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
  const { dbUser, accessToken, oid, providerAccountId, userEmail, userName, userImage, fallbackGroups, fallbackRoles } = params;

  console.log("[auth] microsoft jwt sign-in started", {
    userId: dbUser.id,
    accessTokenPresent: !!accessToken,
    oidPresent: !!oid,
  });

  const profileUpdate: { microsoftUserId?: string; name?: string; image?: string } = {};
  if (oid && dbUser.microsoftUserId !== oid) profileUpdate.microsoftUserId = oid;
  // Backfill only — never overwrite an existing (possibly admin-set) name/image.
  if (!dbUser.name && userName) profileUpdate.name = userName;
  if (!dbUser.image && userImage) profileUpdate.image = userImage;
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
  });

  // refreshed should always be non-null (we just wrote to this exact row) —
  // the fallback is only for the theoretical case it vanished mid-request,
  // and it deliberately falls back to the pre-sync `dbUser` rather than
  // inventing data, never silently promoting/crashing either way.
  return refreshed ?? dbUser;
}
