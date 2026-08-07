import { cookies } from "next/headers";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getUserDepartmentMemberships } from "@/lib/services/department-membership-service";
import { canViewAllDepartments } from "@/lib/permissions";
import { ALL_WORKSPACES_VALUE } from "@/types/department";
import type { ActiveWorkspaceContext, WorkspaceOption } from "@/types/department";

export { ALL_WORKSPACES_VALUE };

/** Cookie name the workspace switch endpoint (Phase 2B) writes to and this reads from. */
export const ACTIVE_WORKSPACE_COOKIE = "active_department_id";

/**
 * Hard cap on how many workspaces the switcher dropdown ever loads/renders
 * at once — both the initial (unfiltered) list AND each search result page.
 * Anything beyond this is reachable only through search, never a giant
 * unbounded list shipped to the client. See listAccessibleWorkspaces below.
 */
export const WORKSPACE_LIST_TAKE = 20;

/**
 * The accessible-workspace {id, name} list for the workspace switcher —
 * deliberately its own lightweight, TAKE-BOUNDED query, distinct from
 * listDepartments() (unbounded, used by the admin Departments management
 * page with full counts/relations) and getUserDepartmentMemberships()
 * (full membership rows, used for permission/role resolution). Used for
 * BOTH the switcher's initial (unfiltered) view and its search box — same
 * authorization rule as resolveActiveWorkspace below: a canViewAllDepartments
 * role (ADMIN/DIRECTOR) sees every active department company-wide; everyone
 * else sees only departments they hold an active membership in. The actual
 * `take`/`WHERE name ILIKE` filtering happens in the database — this never
 * fetches the full table and slices/filters in Node.
 */
export async function listAccessibleWorkspaces(
  userId: string,
  role: Role,
  options: { search?: string; take?: number } = {}
): Promise<WorkspaceOption[]> {
  const take = options.take ?? WORKSPACE_LIST_TAKE;
  const search = options.search?.trim();
  const nameFilter = search ? { name: { contains: search, mode: "insensitive" as const } } : {};

  if (canViewAllDepartments(role)) {
    return prisma.department.findMany({
      where: { isActive: true, ...nameFilter },
      orderBy: { name: "asc" },
      take,
      select: { id: true, name: true },
    });
  }

  return prisma.department.findMany({
    where: { isActive: true, memberships: { some: { userId, isActive: true } }, ...nameFilter },
    orderBy: { name: "asc" },
    take,
    select: { id: true, name: true },
  });
}

/**
 * Ensures the currently-active department is present in a (take-bounded)
 * workspace list, even when it wasn't among the first N by name — a real
 * requirement, not a nicety: without this, switching to a department that
 * happens to sort after the 20th alphabetically would make the switcher's
 * own trigger/checkmark unable to find it in `departments`, since it simply
 * wasn't in the list at all. Only ever does a SECOND query (one row, by
 * primary key) in the uncommon case it's missing — never fetches the full
 * table to check.
 */
async function ensureActiveWorkspaceIncluded(
  list: WorkspaceOption[],
  activeDepartmentId: string | null
): Promise<WorkspaceOption[]> {
  if (!activeDepartmentId || list.some((d) => d.id === activeDepartmentId)) return list;
  const active = await prisma.department.findUnique({
    where: { id: activeDepartmentId },
    select: { id: true, name: true },
  });
  return active ? [active, ...list] : list;
}

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
    if (requestedDepartmentId === ALL_WORKSPACES_VALUE) {
      const departments = await listAccessibleWorkspaces(userId, role);
      return { departmentId: null, isSystemAdmin, canViewAllDepartments: true, isAllSelected: true, departments };
    }

    // Validated by a targeted single-row lookup — NEVER by searching the
    // (now take-bounded) display list below, which would otherwise
    // incorrectly discard a valid, already-selected department just
    // because it doesn't happen to sort into the first WORKSPACE_LIST_TAKE
    // by name (see WORKSPACE_LIST_TAKE's own doc comment on this file for
    // the full "preserve the currently selected workspace" requirement).
    const requestedValid = requestedDepartmentId
      ? await prisma.department.findFirst({ where: { id: requestedDepartmentId, isActive: true }, select: { id: true } })
      : null;

    // The initial (unfiltered) display list is already ordered by name
    // ascending and take-bounded — its first entry is exactly the same
    // "first active department by name" this used to compute from the full
    // list, so no separate query is needed for this fallback.
    const departments = await listAccessibleWorkspaces(userId, role);
    const resolvedDepartmentId = requestedValid?.id ?? departments[0]?.id ?? null;

    return {
      // No valid cookie yet defaults to the first active department (not
      // "All") — an explicit, confirmed choice, not an oversight: keeps
      // System Admin's existing behavior unchanged, "All Workspaces" stays a
      // deliberate selection rather than a surprising default.
      departmentId: resolvedDepartmentId,
      isSystemAdmin,
      canViewAllDepartments: true,
      isAllSelected: false,
      departments: await ensureActiveWorkspaceIncluded(departments, resolvedDepartmentId),
    };
  }

  const memberships = await getUserDepartmentMemberships(userId);

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

  // Take-bounded display list, same as the canViewAllDepartments branch
  // above — in practice a regular member's own membership count is always
  // well under WORKSPACE_LIST_TAKE, so this is a safety cap that's never
  // actually reached, not a behavior change; the switcher's search box
  // (also scoped to this user's own memberships, see listAccessibleWorkspaces)
  // is what reaches the rest in the rare case it is.
  const departments = await ensureActiveWorkspaceIncluded(await listAccessibleWorkspaces(userId, role), departmentId);

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
