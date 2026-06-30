import { Role } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { cache } from "react";

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
  return hasRole(role, Role.ADMIN, Role.IT_AGENT, Role.DEPARTMENT_MANAGER);
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
