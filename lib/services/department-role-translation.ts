/**
 * Translates a department-scoped role into the global Role it should grant
 * when a MicrosoftDepartmentMapping drives a user's global standing, plus
 * the guardrail that decides whether a user is even eligible for that sync
 * this login. Both functions are pure (no DB, no network) so they're
 * directly unit-testable — see scripts/test-microsoft-role-sync.ts.
 */
import { DepartmentRole, GlobalRoleSource, Role } from "@prisma/client";

// Role.ADMIN deliberately never appears as a value here — a Microsoft
// mapping can never grant System Admin, by construction, not by a runtime
// check that could be bypassed or forgotten. DEPARTMENT_ADMIN's ceiling is
// DEPARTMENT_MANAGER for the same reason.
const DEPARTMENT_ROLE_TO_GLOBAL_ROLE: Record<DepartmentRole, Role> = {
  DEPARTMENT_ADMIN: Role.DEPARTMENT_MANAGER,
  DEPARTMENT_MANAGER: Role.DEPARTMENT_MANAGER,
  PROJECT_MANAGER: Role.IT_AGENT,
  AGENT_ASSIGNEE: Role.IT_AGENT,
  REQUESTER: Role.USER,
  VIEWER: Role.USER,
};

export function translateDepartmentRoleToGlobalRole(role: DepartmentRole): Role {
  return DEPARTMENT_ROLE_TO_GLOBAL_ROLE[role];
}

/**
 * Whether Microsoft login sync is allowed to write User.role/departmentId
 * for this user. Two independent guarantees, not one:
 *  - Role.ADMIN is never touched, regardless of how it got there (belt and
 *    suspenders — the translation table above can't produce ADMIN anyway,
 *    but this also protects a user promoted to ADMIN some other way).
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
