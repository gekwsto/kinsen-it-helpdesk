/**
 * Orchestrates Microsoft Graph-based department sync during login. Called
 * once, from lib/auth.ts's jwt callback, on Microsoft sign-in only — never
 * on page renders, API requests, or workspace switches.
 */
import { resolveDepartmentMemberships } from "@/lib/services/microsoft-mapping-service";
import { syncDepartmentMemberships } from "@/lib/services/department-membership-service";
import { fetchMicrosoftGraphProfile, type GraphUserProfile } from "@/lib/services/microsoft-graph-profile-service";
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
  const resolved = await resolveDepartmentMemberships(claims);
  await syncDepartmentMemberships(userId, resolved);

  console.log("[microsoft-department-sync] Synced department membership from Graph", {
    email,
    userId,
    departmentPresent: claims.department !== null,
    resolvedCount: resolved.length,
  });
}
