/**
 * Who currently holds `projectRequest.approve` for a given department —
 * extracted from lib/services/project-request-service.ts (its own original
 * home) into this standalone module so both that file AND
 * lib/services/project-request-setup-reminder-service.ts can import it
 * without a circular dependency between the two (the reminder service needs
 * this; project-request-service.ts needs the reminder service's
 * scheduleSetupReminderInTx/cancelSetupReminderInTx). Behavior is unchanged
 * from before the extraction — same functions, same bodies, same callers.
 */
import { prisma } from "@/lib/prisma";
import { hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import { DEPARTMENT_ROLE_OPTIONS } from "@/lib/services/department-role-translation";
import { Role, DepartmentRole } from "@prisma/client";

export const APPROVE_PERMISSION_KEY = "projectRequest.approve";

/** Every roleKey (DepartmentRole strings, global Role enum values, or custom-role keys) currently granting `projectRequest.approve` — a real RolePermission catalogue lookup, never the runtime ADMIN bypass (so this also correctly reflects ADMIN's own explicit, migrated grant row). */
async function getRoleKeysWithApprovePermission() {
  const rows = await prisma.rolePermission.findMany({
    where: { permission: { key: APPROVE_PERMISSION_KEY } },
    select: { roleKey: true },
  });
  const roleKeys = rows.map((r) => r.roleKey);
  const departmentRoleValues = new Set<string>(DEPARTMENT_ROLE_OPTIONS as string[]);
  const globalRoleValues = new Set<string>(Object.values(Role));
  return {
    // DEPARTMENT_MANAGER is intentionally reachable via both sets — it's a
    // single shared roleKey for the global Role and DepartmentRole enum
    // values (see prisma/seed.ts's own comment on this).
    departmentRoles: roleKeys.filter((k): k is DepartmentRole => departmentRoleValues.has(k)),
    globalRoles: roleKeys.filter((k): k is Role => globalRoleValues.has(k)),
    // Every roleKey, including admin-created custom-role keys that aren't a
    // Role/DepartmentRole enum member at all — matched against
    // User.customRole.key / DepartmentMembership.customRole.key.
    allRoleKeys: roleKeys,
  };
}

/**
 * Every ACTIVE user who effectively holds `projectRequest.approve` for
 * `departmentId` — a broad, cheap SQL prefilter by roleKey (never misses
 * anyone) followed by the exact hasEffectiveEntityPermission check per
 * candidate (never over-includes), same two-phase shape as
 * lib/services/assignment-eligibility-service.ts's getAssignableUsersForEntity.
 * Used by the submission-time notification fan-out, the delayed setup
 * reminder fan-out, and reusable anywhere else "who can approve this" needs
 * a real user list.
 */
export async function getEligibleApproverUserIds(departmentId: string): Promise<string[]> {
  const { departmentRoles, globalRoles, allRoleKeys } = await getRoleKeysWithApprovePermission();

  const orConditions: Record<string, unknown>[] = [];
  if (globalRoles.length > 0) orConditions.push({ role: { in: globalRoles } });
  if (allRoleKeys.length > 0) orConditions.push({ customRole: { key: { in: allRoleKeys } } });
  if (departmentRoles.length > 0) {
    orConditions.push({ departmentMemberships: { some: { departmentId, isActive: true, role: { in: departmentRoles } } } });
  }
  if (allRoleKeys.length > 0) {
    orConditions.push({ departmentMemberships: { some: { departmentId, isActive: true, customRole: { key: { in: allRoleKeys } } } } });
  }
  if (orConditions.length === 0) return [];

  const candidates = await prisma.user.findMany({
    where: { isActive: true, OR: orConditions },
    select: { id: true, role: true, customRoleId: true },
  });

  const eligible: string[] = [];
  for (const candidate of candidates) {
    if (await hasEffectiveEntityPermission(candidate.id, candidate.role, candidate.customRoleId, departmentId, APPROVE_PERMISSION_KEY)) {
      eligible.push(candidate.id);
    }
  }
  return eligible;
}
