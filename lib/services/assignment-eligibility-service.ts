/**
 * Single source of truth for "can this user be the assignee/owner/member on
 * a ticket/activity/project" — consumed by both the assignee-dropdown list
 * builders (GET endpoints / Server Components) and the write-path backend
 * validation (POST/PATCH routes), so there is no separate frontend-only
 * filter a raw API call could bypass.
 *
 * Distinct from `ticket.assign`/`activity.edit`/`project.edit` (can the
 * CALLER perform the write) — this answers "is the TARGET user a valid
 * choice," via a new `<entity>.assignable` permission key resolved through
 * the exact same RolePermission table `hasPermission`/`hasDepartmentPermission`
 * already use (lib/permissions.ts) — no parallel permission system.
 *
 * Effective rule (department membership first, cross-department fallback
 * only for canViewAllDepartments roles):
 *   - entity has a department: the user's active DepartmentMembership role
 *     there decides it. No membership in that department -> only Admin/
 *     Director (canViewAllDepartments) fall back to their global role's
 *     permission; anyone else is not assignable there, even if their global
 *     role grants the permission generally (a plain IT_AGENT with no
 *     standing in this specific department is not assignable in it).
 *   - entity has no department (legacy/global row): pure global-role check.
 */
import { prisma } from "@/lib/prisma";
import { Role, DepartmentRole } from "@prisma/client";
import { hasPermission, hasDepartmentPermission, canViewAllDepartments } from "@/lib/permissions";
import { getMembership } from "@/lib/services/department-membership-service";
import { DEPARTMENT_ROLE_OPTIONS } from "@/lib/services/department-role-translation";

export type AssignableEntityType = "ticket" | "activity" | "project";

export interface AssignableUserSummary {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
}

interface AssignabilityCandidate {
  id: string;
  role: Role;
  customRoleId: string | null;
}

function assignablePermissionKey(entityType: AssignableEntityType): string {
  return `${entityType}.assignable`;
}

const GLOBAL_ROLE_ENUM_VALUES = new Set<string>(Object.values(Role));
const DEPARTMENT_ROLE_ENUM_VALUES = new Set<string>(DEPARTMENT_ROLE_OPTIONS as string[]);

/** Core check, reused by the public per-user function below and the list builders' final authoritative filter. */
async function evaluateAssignability(
  candidate: AssignabilityCandidate,
  entityType: AssignableEntityType,
  departmentId: string | null
): Promise<boolean> {
  const permKey = assignablePermissionKey(entityType);

  if (departmentId) {
    const membership = await getMembership(candidate.id, departmentId);
    if (membership) return hasDepartmentPermission(membership.role, permKey, membership.customRoleId);
    if (!canViewAllDepartments(candidate.role)) return false;
  }

  return hasPermission(candidate.role, permKey, candidate.customRoleId);
}

/**
 * Public per-user check for backend write validation — takes a userId (not
 * a pre-loaded user) since callers usually only have the submitted id.
 * Missing/inactive users are never assignable.
 */
export async function userHasAssignablePermissionForEntity(
  userId: string,
  entityType: AssignableEntityType,
  departmentId: string | null
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, customRoleId: true, isActive: true },
  });
  if (!user || !user.isActive) return false;
  return evaluateAssignability(user, entityType, departmentId);
}

/** Every roleKey (DepartmentRole strings, global Role/custom-role keys) currently granting `<entityType>.assignable`. */
async function getRoleKeysWithAssignablePermission(entityType: AssignableEntityType) {
  const rows = await prisma.rolePermission.findMany({
    where: { permission: { key: assignablePermissionKey(entityType) } },
    select: { roleKey: true },
  });
  const roleKeys = rows.map((r) => r.roleKey);
  return {
    // DEPARTMENT_MANAGER is intentionally in both sets — it's a single
    // shared roleKey for the global Role and DepartmentRole enum values.
    departmentRoles: roleKeys.filter((k): k is DepartmentRole => DEPARTMENT_ROLE_ENUM_VALUES.has(k)),
    globalRoles: Array.from(
      new Set<Role>([Role.ADMIN, ...roleKeys.filter((k): k is Role => GLOBAL_ROLE_ENUM_VALUES.has(k))])
    ),
    // Every roleKey, including admin-created custom-role keys that aren't a
    // Role/DepartmentRole enum member at all — matched against User.customRole.key.
    allRoleKeys: roleKeys,
  };
}

/**
 * Eligible assignees for one entity type/department — a broad, cheap SQL
 * prefilter (never misses anyone) followed by the exact `evaluateAssignability`
 * check per candidate (never over-includes) — candidates are already
 * narrowed to plausible role/membership matches, so this stays small, not
 * an N-over-every-user loop.
 */
export async function getAssignableUsersForEntity(
  entityType: AssignableEntityType,
  departmentId: string | null
): Promise<AssignableUserSummary[]> {
  const { departmentRoles, globalRoles, allRoleKeys } = await getRoleKeysWithAssignablePermission(entityType);

  const orConditions: Record<string, unknown>[] = [{ role: { in: globalRoles } }];
  if (allRoleKeys.length > 0) {
    // Global custom role (User.customRoleId).
    orConditions.push({ customRole: { key: { in: allRoleKeys } } });
  }
  if (departmentId && departmentRoles.length > 0) {
    orConditions.push({
      departmentMemberships: { some: { departmentId, isActive: true, role: { in: departmentRoles } } },
    });
  }
  if (departmentId && allRoleKeys.length > 0) {
    // Department-scoped custom role (DepartmentMembership.customRoleId) —
    // distinct from the two conditions above (neither the global-customRole
    // nor the departmentRoles/enum-role condition covers a custom
    // DEPARTMENT-scope CustomRole attached to one specific membership).
    // Without this, evaluateAssignability's per-candidate check below would
    // correctly say "yes" for such a user, but they'd never be gathered as a
    // candidate in the first place — violating this function's own "never
    // misses anyone" prefilter contract.
    orConditions.push({
      departmentMemberships: { some: { departmentId, isActive: true, customRole: { key: { in: allRoleKeys } } } },
    });
  }

  const candidates = await prisma.user.findMany({
    where: { isActive: true, OR: orConditions },
    select: { id: true, name: true, email: true, image: true, role: true, customRoleId: true },
    orderBy: { name: "asc" },
  });

  const eligible: AssignableUserSummary[] = [];
  for (const candidate of candidates) {
    if (await evaluateAssignability(candidate, entityType, departmentId)) {
      eligible.push({ id: candidate.id, name: candidate.name, email: candidate.email, image: candidate.image });
    }
  }
  return eligible;
}

export function getAssignableUsersForTicket(departmentId: string | null): Promise<AssignableUserSummary[]> {
  return getAssignableUsersForEntity("ticket", departmentId);
}

export function getAssignableUsersForActivity(departmentId: string | null): Promise<AssignableUserSummary[]> {
  return getAssignableUsersForEntity("activity", departmentId);
}

export function getAssignableUsersForProject(departmentId: string | null): Promise<AssignableUserSummary[]> {
  return getAssignableUsersForEntity("project", departmentId);
}
