import {
  Department,
  DepartmentMembership,
  DepartmentRole,
  MembershipSource,
  MicrosoftDepartmentMapping,
  MicrosoftMappingSourceType,
} from "@prisma/client";

// Re-export enums so callers don't need to import from @prisma/client directly.
export { DepartmentRole, MembershipSource, MicrosoftMappingSourceType };

// ─── Department ────────────────────────────────────────────────────────────────

export type DepartmentSummary = Pick<
  Department,
  "id" | "name" | "slug" | "description" | "isActive" | "businessUnitId"
>;

export type DepartmentWithCounts = DepartmentSummary & {
  businessUnit: { id: string; name: string } | null;
  _count: { users: number; tickets: number };
};

// ─── Membership ────────────────────────────────────────────────────────────────

export type DepartmentMembershipView = Pick<
  DepartmentMembership,
  "id" | "userId" | "departmentId" | "role" | "customRoleId" | "source" | "isPrimary" | "isActive"
> & {
  department: DepartmentSummary;
};

export type ResolvedMembership = {
  departmentId: string;
  role: DepartmentRole;
  /** Custom DEPARTMENT/BOTH-scope role (CustomRole.id) this membership should carry instead of the placeholder `role` above, or null for a plain built-in role — see MicrosoftDepartmentMapping.departmentCustomRoleId. */
  customRoleId: string | null;
  source: MembershipSource;
};

// ─── Microsoft identity / mapping ───────────────────────────────────────────────

// `oid`/`email`/`name` come from the OIDC ID token. `department`/`jobTitle`
// are fetched live from Microsoft Graph (GET /me) during login sync — see
// lib/services/microsoft-department-sync-service.ts — and are not ID-token
// claims. `groups`/`roles` are typed optional because they still require
// Azure AD app-registration changes (a "groups" claim / App Roles + a
// "roles" claim) that are outside this codebase — see
// lib/services/microsoft-mapping-service.ts.
export interface MicrosoftIdentityClaims {
  oid: string;
  email: string;
  name?: string | null;
  /** Microsoft Graph `user.department` — fetched via GET /me during login sync, not an ID-token claim. */
  department?: string | null;
  /** Microsoft Graph `user.jobTitle` — fetched via GET /me during login sync, same as department. */
  jobTitle?: string | null;
  /** Microsoft Graph `user.companyName` — FIND-003: same multi-company organization-placement signal the full Directory Sync already uses (organization-company-department-resolver.ts), now also carried through the login path. */
  companyName?: string | null;
  /** Microsoft Graph `user.userType` ("Member"/"Guest") — FIND-003: organization-sync eligibility (organization-directory-eligibility-service.ts) needs this at login too, not just full sync. */
  userType?: string | null;
  /** Entra group display names/ids — requires a groups claim/consent, not configured today. */
  groups?: string[];
  /** Entra app role values assigned to the app registration — not configured today. */
  roles?: string[];
}

export type MicrosoftMappingView = Pick<
  MicrosoftDepartmentMapping,
  | "id"
  | "sourceType"
  | "microsoftValue"
  | "domain"
  | "departmentId"
  | "role"
  | "globalCustomRoleId"
  | "departmentRole"
  | "departmentCustomRoleId"
  | "isActive"
> & {
  department: Pick<Department, "id" | "name" | "slug">;
  /** Joined for display — includes isActive so the UI can render "(no longer eligible)" for a stale/deactivated selection without a second lookup. Null when globalCustomRoleId is null. */
  globalCustomRole: { id: string; name: string; isActive: boolean } | null;
  departmentCustomRole: { id: string; name: string; isActive: boolean } | null;
};

// ─── Workspace ─────────────────────────────────────────────────────────────────

/**
 * Cookie/API sentinel for "All Workspaces" — only ever honored for
 * canViewAllDepartments(role) (lib/permissions.ts). Lives here (not
 * lib/services/workspace-service.ts) so client components can import it
 * without pulling in that file's `next/headers` (server-only) import.
 */
export const ALL_WORKSPACES_VALUE = "ALL";

// The department a user is currently "in," plus what else they could switch
// to. `departmentId: null` means no usable department was resolved (either
// zero memberships — pending-setup state — or more than one with none
// selected/primary — selector state); the caller decides which by checking
// `departments.length`.
/**
 * Lightweight {id, name} projection for the workspace switcher — deliberately
 * NOT the full DepartmentSummary (slug/description/isActive/businessUnitId
 * aren't needed to render a dropdown row) so the switcher's initial/search
 * queries (lib/services/workspace-service.ts's listAccessibleWorkspaces)
 * select only what's actually rendered.
 */
export interface WorkspaceOption {
  id: string;
  name: string;
}

export interface ActiveWorkspaceContext {
  departmentId: string | null;
  /** True for global Role.ADMIN — bypasses membership checks, sees every active department. */
  isSystemAdmin: boolean;
  /** True for Role.ADMIN or Role.DIRECTOR — see canViewAllDepartments() in lib/permissions.ts. */
  canViewAllDepartments: boolean;
  /**
   * True when the user explicitly picked "All Workspaces" (only offered to
   * canViewAllDepartments roles) — `departmentId` is null in this case, but
   * unlike the ambiguous/pending-setup null case for a regular user, it means
   * "deliberately unrestricted," not "nothing resolved yet."
   */
  isAllSelected: boolean;
  /**
   * The switcher's INITIAL (take-bounded, see WORKSPACE_LIST_TAKE) list —
   * never the full accessible set for a canViewAllDepartments role. Always
   * includes the currently-active department even if it wouldn't otherwise
   * be among the first N. The rest are reachable via the switcher's search
   * box (GET /api/workspace/search), never preloaded here.
   */
  departments: WorkspaceOption[];
}

// ─── Permissions ───────────────────────────────────────────────────────────────

// Department-scoped permission keys reuse the existing global Permission
// catalogue (module: "tickets" | "projects" | "activities" | "goals") —
// this alias just documents intent at call sites, it is not a separate set.
export type DepartmentPermissionKey = string;

export interface DepartmentAccessResult {
  isSystemAdmin: boolean;
  membership: DepartmentMembershipView | null;
}
