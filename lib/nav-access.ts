import { Role } from "@prisma/client";

/**
 * Pure, dependency-free Role checks — no prisma/auth/next-headers imports,
 * unlike the rest of lib/permissions.ts (which re-exports everything below
 * for backward compatibility with every existing server-side import). This
 * split exists so CLIENT components (components/layout/sidebar.tsx,
 * components/navigation/app-route-prefetcher.tsx) can import the exact same
 * role logic Sidebar has always used, without pulling prisma/next/headers
 * into the client bundle — importing anything from lib/permissions.ts
 * itself into a "use client" file would try to bundle those server-only
 * dependencies and fail. One authorization source, safe on both sides.
 */

export function hasRole(userRole: Role, ...allowedRoles: Role[]): boolean {
  return allowedRoles.includes(userRole);
}

export function isAdmin(role: Role): boolean {
  return role === Role.ADMIN;
}

export function canManageProjects(role: Role): boolean {
  return hasRole(role, Role.ADMIN, Role.IT_AGENT, Role.DEPARTMENT_MANAGER, Role.DIRECTOR);
}

/**
 * Cross-department oversight: Admin (full system access) and Director
 * (view-all + create-anywhere) both see/act across every department. See
 * lib/permissions.ts's fuller doc comment (re-exported unchanged) for the
 * complete rationale — kept here verbatim since this is the real definition.
 */
export function canViewAllDepartments(role: Role): boolean {
  return role === Role.ADMIN || role === Role.DIRECTOR;
}
