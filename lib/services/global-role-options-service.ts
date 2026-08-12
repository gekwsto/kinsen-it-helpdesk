/**
 * Unified list of GLOBAL-role choices for any "assign a global role"
 * dropdown — sourced ENTIRELY from CustomRole, the authoritative persisted
 * role catalogue, exactly mirroring
 * lib/services/department-role-options-service.ts's getDepartmentRoleOptions.
 *
 * The built-in half is no longer built from Object.values(Role) — a Role
 * enum member is only "available" here if it has a matching, active
 * CustomRole row (isBuiltIn: true, key === the enum value). This is what
 * makes a legacy enum value like DIRECTOR (present in the Prisma/PostgreSQL
 * Role enum, but with zero mirrored CustomRole row in production — see the
 * 20260718160000_add_director_role migration, which only ran
 * `ALTER TYPE "Role" ADD VALUE 'DIRECTOR'` and never inserted a CustomRole)
 * correctly NOT appear as assignable: enum membership alone is no longer a
 * catalogue.
 */
import { prisma } from "@/lib/prisma";
import { Role, RoleScope } from "@prisma/client";

export interface GlobalRoleOption {
  /** Built-in: the Role enum value itself (e.g. "ADMIN") — the SAME stable identity persisted on User.role. Custom: `custom:<CustomRole.id>`. */
  value: string;
  label: string;
  description?: string;
  isCustom: boolean;
  customRoleId?: string;
  /** The Role enum value to store in User.role — the real role when built-in, a required-but-unused USER placeholder when custom. */
  enumRole: Role;
  /** True unless this role has been disabled in Roles & Permissions. Always populated (not just when includeInactive is set) so a caller that DID ask for inactive rows can tell them apart from active ones. */
  isActive: boolean;
}

/** Real Role enum members — used only to classify a CustomRole row as "built-in identity" vs "custom", never to independently generate options. */
const GLOBAL_ROLE_ENUM_VALUES = new Set<string>(Object.values(Role));

export interface GetGlobalRoleOptionsParams {
  /**
   * Default false: only currently-assignable (isActive: true) roles — the
   * correct list for "Add User" / "Change Global Role to..." dropdowns.
   *
   * true: also include disabled roles. Used ONLY to resolve/preserve an
   * EXISTING user's current display (show a disabled role clearly rather
   * than silently replacing it) — never to offer a disabled role for a new
   * assignment. Callers that pass true are responsible for filtering by
   * `isActive` themselves before rendering anything as a selectable NEW
   * choice.
   */
  includeInactive?: boolean;
}

export async function getGlobalRoleOptions(params?: GetGlobalRoleOptionsParams): Promise<GlobalRoleOption[]> {
  const roles = await prisma.customRole.findMany({
    where: { scope: { not: RoleScope.DEPARTMENT }, ...(params?.includeInactive ? {} : { isActive: true }) },
    // Built-in rows first (matches the previous built-in-then-custom
    // ordering admins are used to), then alphabetical within each group.
    orderBy: [{ isBuiltIn: "desc" }, { name: "asc" }],
  });

  return roles.map((cr): GlobalRoleOption => {
    const isBuiltInEnumRole = cr.isBuiltIn && GLOBAL_ROLE_ENUM_VALUES.has(cr.key);
    if (isBuiltInEnumRole) {
      const enumRole = cr.key as Role;
      return {
        value: enumRole,
        // The persisted, admin-editable name is authoritative — a renamed
        // built-in role must show its current name here, never a stale
        // hardcoded label.
        label: cr.name,
        description: cr.description ?? undefined,
        isCustom: false,
        enumRole,
        isActive: cr.isActive,
      };
    }
    return {
      value: `custom:${cr.id}`,
      label: cr.name,
      description: cr.description ?? undefined,
      isCustom: true,
      customRoleId: cr.id,
      enumRole: Role.USER,
      isActive: cr.isActive,
    };
  });
}
