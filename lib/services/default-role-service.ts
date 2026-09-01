/**
 * Single source of truth for the configurable Default Global Role / Default
 * Department Role — the CustomRole a newly-provisioned user (no explicit
 * Microsoft mapping match) or newly-created DepartmentMembership (no
 * explicit role) gets, instead of the previously hardcoded Role.USER /
 * DepartmentRole.REQUESTER.
 *
 * Backed by DefaultRoleConfig, a singleton row (fixed id "singleton", same
 * idiom as OrganizationSyncLock) — see prisma/schema.prisma. Both fields
 * reference CustomRole.id directly; there is no bare Role/DepartmentRole
 * enum fallback baked into the config itself. Every provisioning call site
 * (lib/services/microsoft-department-sync-service.ts,
 * lib/services/organization-directory-sync-service.ts,
 * lib/services/requester-resolution-service.ts,
 * lib/services/microsoft-department-autocreate-service.ts) resolves through
 * resolveDefaultGlobalRoleAssignment/resolveDefaultDepartmentRoleAssignment
 * below rather than hardcoding a role anywhere itself — this is the ONLY
 * place "what does an unassigned user/membership get" is decided.
 *
 * Precedence this module implements (callers apply the "explicit mapping"
 * tier themselves, before ever consulting this module):
 *   explicit Microsoft mapping  >  configured default  >  no role
 *
 * "No role" for User.role/DepartmentMembership.role is never literally
 * empty — both columns are NOT NULL enums — it means the legacy enum stays
 * at its schema default (Role.USER / DepartmentRole.REQUESTER) with
 * customRoleId left null, exactly today's pre-existing behavior when no
 * default is configured. This mirrors grantManualMembership's own
 * established placeholder convention (DepartmentRole.VIEWER when a
 * customRoleId IS set) — see resolveDefaultDepartmentRoleAssignment below.
 */
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { Role, DepartmentRole, RoleScope } from "@prisma/client";

const SINGLETON_ID = "singleton";

export type DefaultRoleConfigValidationReason =
  | "ROLE_NOT_FOUND"
  | "ROLE_INACTIVE"
  | "INVALID_SCOPE_FOR_GLOBAL_DEFAULT"
  | "INVALID_SCOPE_FOR_DEPARTMENT_DEFAULT";

export class DefaultRoleConfigValidationError extends Error {
  constructor(public reason: DefaultRoleConfigValidationReason, message: string) {
    super(message);
    this.name = "DefaultRoleConfigValidationError";
  }
}

export interface DefaultRoleConfigView {
  defaultGlobalCustomRole: { id: string; name: string; key: string; scope: RoleScope; isActive: boolean } | null;
  defaultDepartmentCustomRole: { id: string; name: string; key: string; scope: RoleScope; isActive: boolean } | null;
}

const CUSTOM_ROLE_SUMMARY_SELECT = { id: true, name: true, key: true, scope: true, isActive: true } as const;

/** Raw config row + resolved CustomRole rows, or an all-null view if the singleton row doesn't exist yet (never created — an admin hasn't configured anything). */
export async function getDefaultRoleConfig(db: Prisma.TransactionClient | typeof prisma = prisma): Promise<DefaultRoleConfigView> {
  const row = await db.defaultRoleConfig.findUnique({
    where: { id: SINGLETON_ID },
    select: {
      defaultGlobalCustomRole: { select: CUSTOM_ROLE_SUMMARY_SELECT },
      defaultDepartmentCustomRole: { select: CUSTOM_ROLE_SUMMARY_SELECT },
    },
  });
  return {
    defaultGlobalCustomRole: row?.defaultGlobalCustomRole ?? null,
    defaultDepartmentCustomRole: row?.defaultDepartmentCustomRole ?? null,
  };
}

/**
 * The assignment a brand-new, never-touched user's global role should get
 * when no explicit Microsoft mapping matched. `role` is always the required
 * Role.USER placeholder (a global-scope custom role assignment always keeps
 * the enum column at USER, exactly like every other global-custom-role
 * assignment in this codebase — see lib/services/microsoft-mapping-service.ts's
 * resolveGlobalRoleAssignment). `customRoleId` is null when no default is
 * configured, or when the configured default has since become invalid
 * (deleted/deactivated/rescoped — defense in depth; the deletion/
 * deactivation guard in app/api/admin/roles/[id]/route.ts is what's supposed
 * to prevent this from ever happening, but a provisioning path must never
 * hard-fail or silently misassign a role just because that invariant was
 * somehow violated) — in both cases this is IDENTICAL to today's pre-feature
 * behavior (role: USER, customRoleId: null).
 */
export async function resolveDefaultGlobalRoleAssignment(): Promise<{ role: Role; customRoleId: string | null }> {
  const config = await getDefaultRoleConfig();
  const candidate = config.defaultGlobalCustomRole;
  const valid = !!candidate && candidate.isActive && candidate.scope !== RoleScope.DEPARTMENT;
  return { role: Role.USER, customRoleId: valid ? candidate!.id : null };
}

/**
 * Department-scoped mirror of resolveDefaultGlobalRoleAssignment above.
 * `role` is DepartmentRole.VIEWER when a default IS configured (matching
 * grantManualMembership's placeholder convention for any custom-role
 * assignment) or DepartmentRole.REQUESTER — the pre-existing hardcoded
 * fallback — when none is configured/valid, so a caller that ends up with
 * customRoleId: null sees the exact same enum value it always did.
 */
export async function resolveDefaultDepartmentRoleAssignment(): Promise<{ role: DepartmentRole; customRoleId: string | null }> {
  const config = await getDefaultRoleConfig();
  const candidate = config.defaultDepartmentCustomRole;
  const valid = !!candidate && candidate.isActive && candidate.scope !== RoleScope.GLOBAL;
  return {
    role: valid ? DepartmentRole.VIEWER : DepartmentRole.REQUESTER,
    customRoleId: valid ? candidate!.id : null,
  };
}

async function assertEligibleCustomRole(
  customRoleId: string,
  disallowedScope: RoleScope,
  invalidScopeReason: DefaultRoleConfigValidationReason
): Promise<void> {
  const role = await prisma.customRole.findUnique({ where: { id: customRoleId }, select: { isActive: true, scope: true } });
  if (!role) throw new DefaultRoleConfigValidationError("ROLE_NOT_FOUND", "That role no longer exists.");
  if (!role.isActive) throw new DefaultRoleConfigValidationError("ROLE_INACTIVE", "That role is disabled and cannot be set as a default.");
  if (role.scope === disallowedScope) {
    throw new DefaultRoleConfigValidationError(
      invalidScopeReason,
      invalidScopeReason === "INVALID_SCOPE_FOR_GLOBAL_DEFAULT"
        ? "The Default Global Role must be a GLOBAL or BOTH-scope role."
        : "The Default Department Role must be a DEPARTMENT or BOTH-scope role."
    );
  }
}

/** Admin-facing setter — validates scope/active (throws DefaultRoleConfigValidationError otherwise) before persisting. Pass null to clear the default entirely. */
export async function setDefaultGlobalRole(customRoleId: string | null): Promise<DefaultRoleConfigView> {
  if (customRoleId) await assertEligibleCustomRole(customRoleId, RoleScope.DEPARTMENT, "INVALID_SCOPE_FOR_GLOBAL_DEFAULT");
  await prisma.defaultRoleConfig.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, defaultGlobalCustomRoleId: customRoleId },
    update: { defaultGlobalCustomRoleId: customRoleId },
  });
  return getDefaultRoleConfig();
}

/** Admin-facing setter — validates scope/active (throws DefaultRoleConfigValidationError otherwise) before persisting. Pass null to clear the default entirely. */
export async function setDefaultDepartmentRole(customRoleId: string | null): Promise<DefaultRoleConfigView> {
  if (customRoleId) await assertEligibleCustomRole(customRoleId, RoleScope.GLOBAL, "INVALID_SCOPE_FOR_DEPARTMENT_DEFAULT");
  await prisma.defaultRoleConfig.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, defaultDepartmentCustomRoleId: customRoleId },
    update: { defaultDepartmentCustomRoleId: customRoleId },
  });
  return getDefaultRoleConfig();
}

/**
 * Used by the CustomRole delete/deactivate guard (app/api/admin/roles/[id]/route.ts)
 * — a role currently configured as either default can never be removed or
 * disabled until the default is changed/cleared first, so provisioning
 * never silently falls back to "no role" as a side effect of an unrelated
 * role-management action.
 */
export async function isCustomRoleConfiguredAsDefault(
  customRoleId: string
): Promise<{ asGlobalDefault: boolean; asDepartmentDefault: boolean }> {
  const row = await prisma.defaultRoleConfig.findUnique({
    where: { id: SINGLETON_ID },
    select: { defaultGlobalCustomRoleId: true, defaultDepartmentCustomRoleId: true },
  });
  return {
    asGlobalDefault: row?.defaultGlobalCustomRoleId === customRoleId,
    asDepartmentDefault: row?.defaultDepartmentCustomRoleId === customRoleId,
  };
}
