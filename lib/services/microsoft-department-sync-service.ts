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
import { Prisma } from "@prisma/client";
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
