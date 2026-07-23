/**
 * Central, server-and-client-safe home for everything about the two role
 * systems in this app (global `Role` — matches /admin/roles and User.role —
 * vs. department-scoped `DepartmentRole`, used by DepartmentMembership) and
 * how they relate. MicrosoftDepartmentMapping stores BOTH explicitly now:
 * `role` (the GLOBAL Role, so the "Global Role" dropdown shows exactly the
 * same options as Roles & Permissions) and `departmentRole` (the
 * DepartmentRole granted on the resulting DepartmentMembership) — an admin
 * picks both directly; translateGlobalRoleToDepartmentRole below is kept
 * only as (1) the one-time backfill formula for pre-existing mapping rows
 * and (2) a UI "smart default" that pre-fills Department Role from Global
 * Role until the admin edits it directly (see
 * components/admin/microsoft-mapping-management.tsx). Pure (no DB, no
 * network) so it's directly unit-testable — see
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

// The reverse direction: given the GLOBAL role a Microsoft mapping grants,
// what DepartmentRole is a sensible UI default / backfill value for the
// resulting DepartmentMembership. Role.ADMIN's entry is kept only for
// type-completeness — it's unreachable via a mapping, since
// isGlobalRoleAllowedForMicrosoftMapping filters it out upstream of every
// call site that matters.
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
 * Suggested-default-only helper: used (a) once, to backfill pre-existing
 * MicrosoftDepartmentMapping rows' new `departmentRole` column from their
 * `role`, and (b) by the mapping modal to pre-fill Department Role when
 * Global Role changes and the admin hasn't touched Department Role yet.
 * Never used at sync time anymore — resolveDepartmentMemberships
 * (microsoft-mapping-service.ts) reads the mapping's stored `departmentRole`
 * directly, so Global Role and Department Role can be set independently.
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

/**
 * Whether a DepartmentRole is safe for a Microsoft mapping to grant.
 * DEPARTMENT_ADMIN is the department-scoped analog of Role.ADMIN (full
 * control of the department — settings, members, email) so, mirroring
 * isGlobalRoleAllowedForMicrosoftMapping above, it can never be granted by an
 * unattended login-sync mapping — enforced here, not just hidden in the UI.
 */
export function isDepartmentRoleAllowedForMicrosoftMapping(role: DepartmentRole): boolean {
  return role !== DepartmentRole.DEPARTMENT_ADMIN;
}

export interface MicrosoftMappingRoleOption {
  value: Role;
  label: string;
  description: string;
  /** Human-readable label of the DepartmentRole this Role translates to by default (a suggestion, not an enforced link). */
  departmentRolePreview: string;
}

/**
 * The actual options a Microsoft mapping's "Global Role" dropdown should
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

export interface MicrosoftMappingDepartmentRoleOption {
  value: DepartmentRole;
  label: string;
  description: string;
}

/**
 * The actual options a Microsoft mapping's "Department Role" dropdown should
 * show — every built-in DepartmentRole except DEPARTMENT_ADMIN (see
 * isDepartmentRoleAllowedForMicrosoftMapping). Custom department roles are
 * out of scope for this feature — a mapping only grants one of these 5
 * built-in values, never a CustomRole.
 */
export function getMicrosoftMappingDepartmentRoleOptions(): MicrosoftMappingDepartmentRoleOption[] {
  return DEPARTMENT_ROLE_OPTIONS.filter(isDepartmentRoleAllowedForMicrosoftMapping).map((role) => ({
    value: role,
    label: DEPARTMENT_ROLE_LABELS[role],
    description: DEPARTMENT_ROLE_DESCRIPTIONS[role],
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

// ─── Department Hierarchy (My Departments popup) ──────────────────────────────
//
// Operational rank for a department's members — used by
// app/api/departments/[id]/hierarchy/route.ts. Distinct from the global vs.
// department Role systems above: this collapses both into one ordered tree
// for display, with two deliberate overrides driven by the SAME fact this
// file already documents (translateGlobalRoleToDepartmentRole's comment on
// Role.DIRECTOR) — Director's real power is a global-role bypass
// (canViewAllDepartments), not a DepartmentRole value, so a Director's
// DepartmentMembership.role is frequently just a meaningless placeholder
// (e.g. VIEWER from Microsoft sync). Ranking a Director by that placeholder
// would be wrong, hence the override below.

export type HierarchyTier =
  | "SYSTEM_ADMIN"
  | "DIRECTOR"
  | "DEPARTMENT_MANAGER"
  | "DEPARTMENT_ADMIN"
  | "PROJECT_MANAGER"
  | "OTHER_ROLES"
  | "AGENT"
  | "REQUESTER"
  | "VIEWER";

/** Top-down order — index is the sort rank, lower renders first. SYSTEM_ADMIN is rendered as a visually separate group (see the dialog), never mixed into the 7-tier operational list, but still needs a position for internal sorting. */
export const HIERARCHY_TIER_ORDER: HierarchyTier[] = [
  "SYSTEM_ADMIN",
  "DIRECTOR",
  "DEPARTMENT_MANAGER",
  "DEPARTMENT_ADMIN",
  "PROJECT_MANAGER",
  "OTHER_ROLES",
  "AGENT",
  "REQUESTER",
  "VIEWER",
];

export const HIERARCHY_TIER_LABELS: Record<HierarchyTier, string> = {
  SYSTEM_ADMIN: "System Administrators",
  DIRECTOR: "Director",
  DEPARTMENT_MANAGER: "Department Manager",
  DEPARTMENT_ADMIN: "Department Admin",
  PROJECT_MANAGER: "Project Manager",
  OTHER_ROLES: "Other Roles",
  AGENT: "Agents",
  REQUESTER: "Requesters / Users",
  VIEWER: "Viewer",
};

/** Every DepartmentRole enum value maps 1:1 to a tier — Director has no DepartmentRole member (see the file-level comment above), reached only via the globalRole override below. */
const BUILTIN_DEPARTMENT_ROLE_TIER: Record<DepartmentRole, HierarchyTier> = {
  DEPARTMENT_ADMIN: "DEPARTMENT_ADMIN",
  DEPARTMENT_MANAGER: "DEPARTMENT_MANAGER",
  PROJECT_MANAGER: "PROJECT_MANAGER",
  AGENT_ASSIGNEE: "AGENT",
  REQUESTER: "REQUESTER",
  VIEWER: "VIEWER",
};

/**
 * Operational hierarchy tier for one department member. Order of precedence:
 * 1. Global Role.ADMIN -> SYSTEM_ADMIN (utility group, outside the tree).
 * 2. Global Role.DIRECTOR -> DIRECTOR, regardless of their DepartmentMembership.role
 *    value (see the file-level comment — that value is frequently a
 *    meaningless placeholder for a Director, never ranked by it).
 * 3. An explicit customRole: a built-in one (isBuiltIn: true) ranks by
 *    whichever DepartmentRole its key matches; a genuinely custom one
 *    (isBuiltIn: false) always lands in OTHER_ROLES — never guessed above
 *    Director/Department Manager, per the explicit product requirement.
 * 4. Otherwise, the membership's own DepartmentRole value, direct 1:1 lookup.
 */
export function getDepartmentHierarchyTier(member: {
  globalRole: Role;
  departmentRole: DepartmentRole;
  customRole: { key: string; isBuiltIn: boolean } | null;
}): HierarchyTier {
  if (member.globalRole === Role.ADMIN) return "SYSTEM_ADMIN";
  if (member.globalRole === Role.DIRECTOR) return "DIRECTOR";

  if (member.customRole) {
    if (!member.customRole.isBuiltIn) return "OTHER_ROLES";
    return BUILTIN_DEPARTMENT_ROLE_TIER[member.customRole.key as DepartmentRole] ?? "OTHER_ROLES";
  }

  return BUILTIN_DEPARTMENT_ROLE_TIER[member.departmentRole] ?? "OTHER_ROLES";
}
