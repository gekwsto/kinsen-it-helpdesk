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
  "id" | "userId" | "departmentId" | "role" | "source" | "isPrimary" | "isActive"
> & {
  department: DepartmentSummary;
};

export type ResolvedMembership = {
  departmentId: string;
  role: DepartmentRole;
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
  /** Entra group display names/ids — requires a groups claim/consent, not configured today. */
  groups?: string[];
  /** Entra app role values assigned to the app registration — not configured today. */
  roles?: string[];
}

export type MicrosoftMappingView = Pick<
  MicrosoftDepartmentMapping,
  "id" | "sourceType" | "microsoftValue" | "departmentId" | "role" | "isActive"
> & {
  department: Pick<Department, "id" | "name" | "slug">;
};

// ─── Workspace ─────────────────────────────────────────────────────────────────

// The department a user is currently "in," plus what else they could switch
// to. `departmentId: null` means no usable department was resolved (either
// zero memberships — pending-setup state — or more than one with none
// selected/primary — selector state); the caller decides which by checking
// `departments.length`.
export interface ActiveWorkspaceContext {
  departmentId: string | null;
  /** True for global Role.ADMIN — bypasses membership checks, sees every active department. */
  isSystemAdmin: boolean;
  departments: DepartmentSummary[];
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
