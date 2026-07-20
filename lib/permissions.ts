import { DepartmentRole, Role } from "@prisma/client";
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
    if (customRole) {
      const keys = await getPermissionsForRole(customRole.key);
      return keys.includes(permissionKey);
    }
  }

  const keys = await getPermissionsForRole(role);
  return keys.includes(permissionKey);
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

export async function hasDepartmentPermission(
  role: DepartmentRole,
  permissionKey: string
): Promise<boolean> {
  const keys = await getPermissionsForRole(role);
  return keys.includes(permissionKey);
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
  const allowed = await hasDepartmentPermission(result.membership!.role, permissionKey);
  if (!allowed) throw new Error("Forbidden");
  return result;
}
