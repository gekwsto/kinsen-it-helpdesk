import { DepartmentRole, Role, RoleScope } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { cache } from "react";
import { getMembership } from "@/lib/services/department-membership-service";
import type { DepartmentAccessResult } from "@/types/department";

export const ROLES = {
  ADMIN: "ADMIN" as Role,
  IT_AGENT: "IT_AGENT" as Role,
  DEPARTMENT_MANAGER: "DEPARTMENT_MANAGER" as Role,
  USER: "USER" as Role,
};

export function hasRole(userRole: Role, ...allowedRoles: Role[]): boolean {
  return allowedRoles.includes(userRole);
}

export function isAdmin(role: Role): boolean {
  return role === Role.ADMIN;
}

export function isITAgent(role: Role): boolean {
  return role === Role.IT_AGENT || role === Role.ADMIN;
}

export function isDepartmentManager(role: Role): boolean {
  return role === Role.DEPARTMENT_MANAGER || role === Role.ADMIN;
}

export function canManageTickets(role: Role): boolean {
  return hasRole(role, Role.ADMIN, Role.IT_AGENT);
}

/**
 * @deprecated Global, not department-scoped — a true regardless of role
 * would let e.g. an IT_AGENT see every department's tickets, not just their
 * own. Use `buildTicketListWhere` (lib/services/department-scope-service.ts)
 * for ticket list/dashboard scoping instead. Left in place (unused by the
 * department-aware call sites) rather than deleted, in case something this
 * pass didn't find still depends on it.
 */
export function canViewAllTickets(role: Role): boolean {
  return hasRole(role, Role.ADMIN, Role.IT_AGENT, Role.DEPARTMENT_MANAGER);
}

export function canManageUsers(role: Role): boolean {
  return isAdmin(role);
}

export function canManageSettings(role: Role): boolean {
  return isAdmin(role);
}

export function canCreateInternalNote(role: Role): boolean {
  return hasRole(role, Role.ADMIN, Role.IT_AGENT);
}

export function canViewInternalNote(role: Role): boolean {
  return hasRole(role, Role.ADMIN, Role.IT_AGENT);
}

export function canAssignTicket(role: Role): boolean {
  return hasRole(role, Role.ADMIN, Role.IT_AGENT);
}

export function canChangeTicketStatus(role: Role): boolean {
  return hasRole(role, Role.ADMIN, Role.IT_AGENT);
}

export function canManageProjects(role: Role): boolean {
  return hasRole(role, Role.ADMIN, Role.IT_AGENT, Role.DEPARTMENT_MANAGER, Role.DIRECTOR);
}

/**
 * Cross-department oversight: Admin (full system access) and Director
 * (view-all + create-anywhere, no admin.access / user.manage / role.manage /
 * department.manage* power) both see/act across every department, rather
 * than being scoped to their own DepartmentMembership rows. Every central
 * scope function in lib/services/department-scope-service.ts and
 * lib/services/workspace-service.ts that used to special-case
 * `role === Role.ADMIN` now uses this instead — Director rides the exact
 * same bypass Admin already had, not a parallel system.
 *
 * Deliberately NOT used by requireDepartmentAccess/requireDepartmentPermission
 * below — those gate department.manageSettings/department.manageMembers
 * (real department administration), which stays Administrator-only.
 */
export function canViewAllDepartments(role: Role): boolean {
  return role === Role.ADMIN || role === Role.DIRECTOR;
}

// ─── Dynamic Permission System ────────────────────────────────────────────────

/**
 * Get all permission keys for a given role from the DB.
 * Uses React's `cache` for request-level deduplication.
 */
export const getPermissionsForRole = cache(async (roleKey: string): Promise<string[]> => {
  const rows = await prisma.rolePermission.findMany({
    where: { roleKey },
    include: { permission: { select: { key: true } } },
  });
  return rows.map((r) => r.permission.key);
});

/**
 * Check if a user role has a given permission key.
 * If customRoleId is provided and not null, checks that custom role's permissions first.
 * ADMIN enum role always returns true.
 */
export async function hasPermission(
  role: Role,
  permissionKey: string,
  customRoleId?: string | null
): Promise<boolean> {
  if (role === Role.ADMIN) return true;

  if (customRoleId) {
    const customRole = await prisma.customRole.findUnique({ where: { id: customRoleId } });
    // A disabled custom role falls through to the base enum role below,
    // exactly like a not-found one already did — disabling never produces a
    // hard "zero permissions" cliff.
    if (customRole && customRole.isActive) {
      const keys = await getPermissionsForRole(customRole.key);
      return keys.includes(permissionKey);
    }
  }

  const keys = await getPermissionsForRole(role);
  return keys.includes(permissionKey);
}

/**
 * Can this user reach the Roles & Permissions admin surface at all —
 * either globally (`role.manage`, covers every role regardless of scope)
 * or narrowly, for department roles only (any `role.department.*` grant).
 * Used to gate GET /api/admin/roles (viewing the list); the more specific
 * canManageRoleScope below gates individual create/update/delete actions.
 */
export async function canManageAnyRoles(role: Role, customRoleId?: string | null): Promise<boolean> {
  if (await hasPermission(role, "role.manage", customRoleId)) return true;
  for (const key of ["role.department.create", "role.department.update", "role.department.delete"]) {
    if (await hasPermission(role, key, customRoleId)) return true;
  }
  return false;
}

/**
 * Gate for a specific create/update/delete action on a role with a given
 * scope. `role.manage` is the blanket permission (covers GLOBAL and
 * DEPARTMENT/BOTH alike — unchanged from before this feature). A
 * `role.department.<action>` grant covers DEPARTMENT/BOTH-scope targets
 * only — never GLOBAL, so a department-role-manager can never touch
 * Administrator/IT Agent/Director/User or an admin-created global custom
 * role through this narrower permission.
 */
export async function canManageRoleScope(
  role: Role,
  customRoleId: string | null | undefined,
  targetScope: RoleScope,
  action: "create" | "update" | "delete"
): Promise<boolean> {
  if (await hasPermission(role, "role.manage", customRoleId)) return true;
  if (targetScope === RoleScope.GLOBAL) return false;
  return hasPermission(role, `role.department.${action}`, customRoleId);
}

/**
 * Server-side permission guard. Throws if the current user lacks the permission.
 */
export async function requirePermission(permissionKey: string): Promise<void> {
  const session = await requireAuth();
  const allowed = await hasPermission(session.user.role, permissionKey, session.user.customRoleId);
  if (!allowed) throw new Error("Forbidden");
}

// ─── Server-side auth guards ──────────────────────────────────────────────────

export async function requireAuth() {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized");
  }
  return session;
}

export async function requireRole(...roles: Role[]) {
  const session = await requireAuth();
  if (!hasRole(session.user.role, ...roles)) {
    throw new Error("Forbidden");
  }
  return session;
}

export async function requireAdmin() {
  return requireRole(Role.ADMIN);
}

export async function requireITAgent() {
  return requireRole(Role.ADMIN, Role.IT_AGENT);
}

// ─── Department-scoped authorization (Phase 1 foundation) ─────────────────────
//
// A thin composable layer over the permission system above, not a parallel
// one: DepartmentRole values are just another roleKey string in the same
// RolePermission table CustomRole.key already uses, so hasDepartmentPermission
// needs no new caching/DB-access code — it's the same getPermissionsForRole().
//
// None of these are called from any existing route yet. Wiring them into
// the tickets/projects/activities endpoints (and fixing canViewAllTickets
// above, which currently lets IT_AGENT/DEPARTMENT_MANAGER see every
// department's tickets) is explicitly Phase 2 — see the architecture plan.

/**
 * Same resolution order as hasPermission: a custom department role
 * (DepartmentMembership.customRoleId → CustomRole.key, scope DEPARTMENT/BOTH)
 * takes priority when set; `role` is the fallback (and the only source for
 * every existing built-in-only membership, unchanged).
 */
export async function hasDepartmentPermission(
  role: DepartmentRole,
  permissionKey: string,
  customRoleId?: string | null
): Promise<boolean> {
  if (customRoleId) {
    const customRole = await prisma.customRole.findUnique({ where: { id: customRoleId } });
    // Same fallback rule as hasPermission above — a disabled custom role
    // falls through to the base DepartmentRole enum.
    if (customRole && customRole.isActive) {
      const keys = await getPermissionsForRole(customRole.key);
      return keys.includes(permissionKey);
    }
  }

  const keys = await getPermissionsForRole(role);
  return keys.includes(permissionKey);
}

/** True if any one of the given permission keys is held — used where a page/action should be reachable by whichever narrower grant a caller has (e.g. department.user.assign OR department.user.unassign OR the older department.manageMembers), rather than requiring one specific key. */
export async function hasAnyDepartmentPermission(
  role: DepartmentRole,
  permissionKeys: string[],
  customRoleId?: string | null
): Promise<boolean> {
  for (const key of permissionKeys) {
    if (await hasDepartmentPermission(role, key, customRoleId)) return true;
  }
  return false;
}

/**
 * Confirms the current user can act within `departmentId` at all: either as
 * a System Admin (global Role.ADMIN bypasses membership entirely, mirroring
 * the ADMIN special-case in hasPermission above), or via an active
 * DepartmentMembership in an active Department. A disabled department, a
 * revoked/missing membership, and "never had one" all resolve to the same
 * clean "Forbidden" rejection — never a crash.
 */
export async function requireDepartmentAccess(departmentId: string): Promise<DepartmentAccessResult> {
  const session = await requireAuth();
  if (isAdmin(session.user.role)) {
    return { isSystemAdmin: true, membership: null };
  }
  const membership = await getMembership(session.user.id, departmentId);
  if (!membership) throw new Error("Forbidden");
  return { isSystemAdmin: false, membership };
}

export async function requireDepartmentPermission(
  departmentId: string,
  permissionKey: string
): Promise<DepartmentAccessResult> {
  const result = await requireDepartmentAccess(departmentId);
  if (result.isSystemAdmin) return result;
  const allowed = await hasDepartmentPermission(result.membership!.role, permissionKey, result.membership!.customRoleId);
  if (!allowed) throw new Error("Forbidden");
  return result;
}

/** Same as requireDepartmentPermission, but passes if the caller holds ANY of the given keys — for pages reachable by more than one narrower grant. */
export async function requireAnyDepartmentPermission(
  departmentId: string,
  permissionKeys: string[]
): Promise<DepartmentAccessResult> {
  const result = await requireDepartmentAccess(departmentId);
  if (result.isSystemAdmin) return result;
  const allowed = await hasAnyDepartmentPermission(result.membership!.role, permissionKeys, result.membership!.customRoleId);
  if (!allowed) throw new Error("Forbidden");
  return result;
}

/**
 * Whether `actingUserId` (the caller, e.g. an admin using Add/Edit User) may
 * assign SOMEONE ELSE into `departmentId` — used by the global user-account
 * routes (app/api/admin/users/*) so setting a user's Primary Department
 * there is gated the same way the department members page's own assign
 * action already is, not just by whatever permission gates the rest of the
 * request. `user.manage`/ADMIN is a blanket bypass; short of that, the
 * caller needs department.user.assign in that specific department via their
 * own DepartmentMembership there — the same standing requireDepartmentPermission
 * would check for the department members page.
 */
export async function canAssignUserToDepartment(
  actingRole: Role,
  actingCustomRoleId: string | null | undefined,
  actingUserId: string,
  departmentId: string
): Promise<boolean> {
  if (await hasPermission(actingRole, "user.manage", actingCustomRoleId)) return true;
  const membership = await getMembership(actingUserId, departmentId);
  if (!membership) return false;
  return hasDepartmentPermission(membership.role, "department.user.assign", membership.customRoleId);
}
