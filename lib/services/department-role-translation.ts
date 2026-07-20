/**
 * Central, server-and-client-safe home for everything about the two role
 * systems in this app (global `Role` — matches /admin/roles and User.role —
 * vs. department-scoped `DepartmentRole`, used by DepartmentMembership) and
 * how they relate. MicrosoftDepartmentMapping.role stores the GLOBAL `Role`
 * directly (so its "Role granted" dropdown shows exactly the same options
 * as Roles & Permissions) — translateGlobalRoleToDepartmentRole derives the
 * DepartmentRole a resulting DepartmentMembership should get. Pure (no DB,
 * no network) so it's directly unit-testable — see
 * scripts/test-microsoft-role-sync.ts. Lives in lib/services/ (not
 * components/admin/) specifically so API routes can import the same
 * functions the UI uses — components/admin/department-role-info.ts
 * re-exports the label/description constants below for its existing
 * consumers, rather than duplicating them.
 */
import { DepartmentRole, GlobalRoleSource, Role } from "@prisma/client";

/** Global Role display labels — matches the built-in CustomRole rows shown on /admin/roles (see prisma/seed.ts's builtInRoles). */
export const GLOBAL_ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Administrator",
  IT_AGENT: "IT Agent",
  DEPARTMENT_MANAGER: "Department Manager",
  DIRECTOR: "Director",
  USER: "User",
};

/** Same source as the labels above — verbatim from prisma/seed.ts's builtInRoles descriptions. */
export const GLOBAL_ROLE_DESCRIPTIONS: Record<Role, string> = {
  ADMIN: "Full access to all features",
  IT_AGENT: "Manage tickets, projects and activities",
  DEPARTMENT_MANAGER: "Manage department projects and goals",
  DIRECTOR: "View and create across all departments — tickets, projects, activities and goals",
  USER: "Submit and view own tickets",
};

/** What each DepartmentRole means — shared across the members page and the Microsoft mapping page. */
export const DEPARTMENT_ROLE_LABELS: Record<DepartmentRole, string> = {
  DEPARTMENT_ADMIN: "Department Admin",
  DEPARTMENT_MANAGER: "Department Manager",
  PROJECT_MANAGER: "Project Manager",
  AGENT_ASSIGNEE: "Agent / Assignee",
  REQUESTER: "Requester",
  VIEWER: "Viewer",
};

export const DEPARTMENT_ROLE_DESCRIPTIONS: Record<DepartmentRole, string> = {
  DEPARTMENT_ADMIN: "Full control of this department — projects, tickets, activities, goals, members and settings.",
  DEPARTMENT_MANAGER: "Manages projects, activities and goals; sees all department tickets, but not member/settings management.",
  PROJECT_MANAGER: "Creates and edits projects and Gantt schedules for this department only.",
  AGENT_ASSIGNEE: "Handles assigned tickets and activities; sees every ticket in this department.",
  REQUESTER: "Creates and tracks their own tickets in this department only.",
  VIEWER: "Read-only access to this department's projects, tickets and activities.",
};

export const DEPARTMENT_ROLE_OPTIONS = Object.values(DepartmentRole);

// The reverse direction: given the GLOBAL role a Microsoft mapping grants
// (MicrosoftDepartmentMapping.role, since a previous phase), what
// DepartmentRole should the resulting DepartmentMembership row get.
// Role.ADMIN's entry is kept only for type-completeness — it's unreachable
// via a mapping, since isGlobalRoleAllowedForMicrosoftMapping filters it out
// upstream of every call site that matters.
const GLOBAL_ROLE_TO_DEPARTMENT_ROLE: Record<Role, DepartmentRole> = {
  ADMIN: DepartmentRole.DEPARTMENT_ADMIN,
  DEPARTMENT_MANAGER: DepartmentRole.DEPARTMENT_MANAGER,
  IT_AGENT: DepartmentRole.AGENT_ASSIGNEE,
  // Director's actual power comes from canViewAllDepartments() (a global-role
  // bypass, no DepartmentMembership required) — this entry only matters if a
  // Microsoft mapping happens to create one anyway, so VIEWER (read-oriented)
  // is the safe, consistent fit rather than granting an elevated department
  // role Director doesn't need.
  DIRECTOR: DepartmentRole.VIEWER,
  USER: DepartmentRole.REQUESTER,
};

/**
 * What DepartmentRole a Microsoft-mapped global Role should grant on the
 * resulting DepartmentMembership — used by resolveDepartmentMemberships
 * (microsoft-mapping-service.ts) so the UI's single Role selection drives
 * both User.role and DepartmentMembership.role consistently, never two
 * independently-decided values.
 */
export function translateGlobalRoleToDepartmentRole(role: Role): DepartmentRole {
  return GLOBAL_ROLE_TO_DEPARTMENT_ROLE[role];
}

/**
 * Whether a global Role is safe for a Microsoft mapping to grant. Microsoft
 * mappings can never grant System Admin — enforced here, not just hidden in
 * the UI (see the role_not_allowed check in microsoft-mapping-service.ts).
 */
export function isGlobalRoleAllowedForMicrosoftMapping(role: Role): boolean {
  return role !== Role.ADMIN;
}

export interface MicrosoftMappingRoleOption {
  value: Role;
  label: string;
  description: string;
  /** Human-readable label of the DepartmentRole this Role translates to for DepartmentMembership. */
  departmentRolePreview: string;
}

/**
 * The actual options a Microsoft mapping's "Role granted" dropdown should
 * show — the same global roles as /admin/roles (Roles & Permissions),
 * minus Administrator. Forbidden roles are simply absent (not included
 * disabled/greyed-out) — shadcn/Radix Select disabled items aren't reliably
 * inert across all interactions, so exclusion is the safer default here.
 */
export function getMicrosoftMappingRoleOptions(): MicrosoftMappingRoleOption[] {
  return Object.values(Role)
    .filter(isGlobalRoleAllowedForMicrosoftMapping)
    .map((role) => ({
      value: role,
      label: GLOBAL_ROLE_LABELS[role],
      description: GLOBAL_ROLE_DESCRIPTIONS[role],
      departmentRolePreview: DEPARTMENT_ROLE_LABELS[translateGlobalRoleToDepartmentRole(role)],
    }));
}

/**
 * Whether Microsoft login sync is allowed to write User.role/departmentId
 * for this user. Two independent guarantees, not one:
 *  - Role.ADMIN is never touched, regardless of how it got there (belt and
 *    suspenders — a mapping can't grant ADMIN in the first place per
 *    isGlobalRoleAllowedForMicrosoftMapping above, but this also protects a
 *    user promoted to ADMIN some other way).
 *  - globalRoleSource === MANUAL means an admin explicitly set this in the
 *    Edit User dialog — protected until they change it again.
 * SYSTEM (untouched default) and MICROSOFT_DEPARTMENT (already
 * Microsoft-managed) are both sync-eligible.
 */
export function shouldSyncGlobalRole(user: { role: Role; globalRoleSource: GlobalRoleSource }): boolean {
  if (user.role === Role.ADMIN) return false;
  if (user.globalRoleSource === GlobalRoleSource.MANUAL) return false;
  return true;
}
