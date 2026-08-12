/**
 * Unified list of department-role choices for any "assign a department
 * role" dropdown (department members add/change-role, admin user edit
 * modal) — sourced ENTIRELY from CustomRole, the authoritative persisted
 * role catalogue. Every built-in DepartmentRole enum value has a canonical
 * mirrored CustomRole row (isBuiltIn: true — seeded by prisma/seed.ts and
 * guaranteed even without it by the
 * 20260812091426_backfill_builtin_department_roles migration), so this
 * function no longer builds the "built-in half" independently from
 * Object.values(DepartmentRole): it queries CustomRole once and classifies
 * each row as built-in (its key matches a real DepartmentRole enum member)
 * or custom. This is what makes `isActive` and a persisted rename apply
 * uniformly to BOTH built-in and custom roles — the previous enum-derived
 * built-in half could never see either.
 *
 * DEPARTMENT_MANAGER (CustomRole.scope BOTH) is included once, from this
 * same query (scope != GLOBAL covers BOTH) — never listed twice.
 */
import { prisma } from "@/lib/prisma";
import { DepartmentRole } from "@prisma/client";
import { DEPARTMENT_ROLE_OPTIONS, DEPARTMENT_ROLE_DESCRIPTIONS } from "@/lib/services/department-role-translation";

export interface DepartmentRoleOption {
  /** Built-in: the DepartmentRole enum value itself (e.g. "AGENT_ASSIGNEE") — the SAME stable identity persisted on DepartmentMembership.role. Custom: `custom:<CustomRole.id>`. */
  value: string;
  label: string;
  description?: string;
  isCustom: boolean;
  customRoleId?: string;
  /** The DepartmentRole enum value to store in DepartmentMembership.role — the real role when built-in, a required-but-unused VIEWER placeholder when custom. */
  enumRole: DepartmentRole;
  /** True unless this role has been disabled in Roles & Permissions. Always populated (not just when includeInactive is set) so a caller that DID ask for inactive rows can tell them apart from active ones. */
  isActive: boolean;
}

/** Real DepartmentRole enum members — used only to classify a CustomRole row as "built-in identity" vs "custom", never to independently generate options. */
const DEPARTMENT_ROLE_ENUM_VALUES = new Set<string>(DEPARTMENT_ROLE_OPTIONS as string[]);

export interface GetDepartmentRoleOptionsParams {
  /**
   * Default false: only currently-assignable (isActive: true) roles — the
   * correct list for "Add Membership" / "Change Role to..." dropdowns,
   * unchanged from before this parameter existed.
   *
   * true: also include disabled roles. Used ONLY to resolve/preserve an
   * EXISTING assignment's current display (task requirement: "if editing a
   * user who already has a disabled role, show the existing role clearly,
   * do not silently replace it") — never to offer a disabled role for a new
   * assignment. Callers that pass true are responsible for filtering by
   * `isActive` themselves before rendering anything as a selectable NEW
   * choice.
   */
  includeInactive?: boolean;
}

export async function getDepartmentRoleOptions(params?: GetDepartmentRoleOptionsParams): Promise<DepartmentRoleOption[]> {
  const roles = await prisma.customRole.findMany({
    where: { scope: { not: "GLOBAL" }, ...(params?.includeInactive ? {} : { isActive: true }) },
    // Built-in rows first (matches the previous built-in-then-custom
    // ordering admins are used to), then alphabetical within each group.
    orderBy: [{ isBuiltIn: "desc" }, { name: "asc" }],
  });

  return roles.map((cr): DepartmentRoleOption => {
    const isBuiltInEnumRole = cr.isBuiltIn && DEPARTMENT_ROLE_ENUM_VALUES.has(cr.key);
    if (isBuiltInEnumRole) {
      const enumRole = cr.key as DepartmentRole;
      return {
        value: enumRole,
        // The persisted, admin-editable name is authoritative — a renamed
        // built-in role (e.g. "Department Admin" -> "IT Department
        // Administrator") must show its current name here, never a stale
        // hardcoded label.
        label: cr.name,
        description: cr.description ?? DEPARTMENT_ROLE_DESCRIPTIONS[enumRole],
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
      enumRole: DepartmentRole.VIEWER,
      isActive: cr.isActive,
    };
  });
}
