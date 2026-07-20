import { cookies } from "next/headers";
import { Role } from "@prisma/client";
import { getUserDepartmentMemberships } from "@/lib/services/department-membership-service";
import { listDepartments, toDepartmentSummary } from "@/lib/services/department-service";
import { canViewAllDepartments } from "@/lib/permissions";
import { ALL_WORKSPACES_VALUE } from "@/types/department";
import type { ActiveWorkspaceContext } from "@/types/department";

export { ALL_WORKSPACES_VALUE };

/** Cookie name the workspace switch endpoint (Phase 2B) writes to and this reads from. */
export const ACTIVE_WORKSPACE_COOKIE = "active_department_id";

/**
 * Resolves which department a user is currently "in," given an optional
 * requested department id (e.g. from a cookie — reading/validating the
 * cookie itself is Phase 2's job when this is wired into a layout/route;
 * this function only does the resolution logic so it stays testable and
 * framework-agnostic).
 *
 * Resolution order: validated requested department > primary membership >
 * sole membership > null (null means "show the pending-setup state" if
 * `departments` is empty, or "show the workspace selector" if it has more
 * than one entry with none implicitly chosen).
 *
 * System Admins (global Role.ADMIN) bypass membership entirely and can
 * resolve to any active department, mirroring how hasPermission() already
 * special-cases ADMIN — see lib/permissions.ts.
 */
export async function resolveActiveWorkspace(
  userId: string,
  role: Role,
  requestedDepartmentId?: string | null
): Promise<ActiveWorkspaceContext> {
  const isSystemAdmin = role === Role.ADMIN;
  const viewsAllDepartments = canViewAllDepartments(role);

  if (viewsAllDepartments) {
    const all = await listDepartments();
    const departments = all.map(toDepartmentSummary);

    if (requestedDepartmentId === ALL_WORKSPACES_VALUE) {
      return { departmentId: null, isSystemAdmin, canViewAllDepartments: true, isAllSelected: true, departments };
    }

    const requestedValid = requestedDepartmentId
      ? departments.find((d) => d.id === requestedDepartmentId)
      : undefined;
    return {
      // No valid cookie yet defaults to the first active department (not
      // "All") — an explicit, confirmed choice, not an oversight: keeps
      // System Admin's existing behavior unchanged, "All Workspaces" stays a
      // deliberate selection rather than a surprising default.
      departmentId: requestedValid?.id ?? departments[0]?.id ?? null,
      isSystemAdmin,
      canViewAllDepartments: true,
      isAllSelected: false,
      departments,
    };
  }

  const memberships = await getUserDepartmentMemberships(userId);
  const departments = memberships.map((m) => m.department);

  const requestedValid = requestedDepartmentId
    ? memberships.find((m) => m.departmentId === requestedDepartmentId)
    : undefined;
  const primary = memberships.find((m) => m.isPrimary);

  let departmentId: string | null = null;
  if (requestedValid) {
    departmentId = requestedValid.departmentId;
  } else if (primary) {
    departmentId = primary.departmentId;
  } else if (memberships.length === 1) {
    departmentId = memberships[0].departmentId;
  }

  return { departmentId, isSystemAdmin: false, canViewAllDepartments: false, isAllSelected: false, departments };
}

/**
 * Phase 2B: reads the active-workspace cookie and resolves it the same way
 * an explicitly-passed department id already was — an invalid/stale cookie
 * (department no longer accessible, since revoked, etc.) is simply not
 * matched by resolveActiveWorkspace's own lookup and falls through to the
 * primary/sole-membership fallback, so there's nothing extra to validate or
 * clean up here. Callers (Server Components, Route Handlers) can call this
 * directly; Client Components consume the result via ActiveWorkspaceProvider
 * (components/workspace/active-workspace-provider.tsx), hydrated from a
 * single server-side call to this function in app/(main)/layout.tsx.
 */
export async function getActiveWorkspace(userId: string, role: Role): Promise<ActiveWorkspaceContext> {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(ACTIVE_WORKSPACE_COOKIE)?.value ?? null;
  return resolveActiveWorkspace(userId, role, cookieValue);
}
