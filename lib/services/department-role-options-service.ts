/**
 * Unified list of department-role choices for any "assign a department
 * role" dropdown (department members add/change-role) — the 6 built-in
 * DepartmentRole enum values, plus any admin-created custom department role
 * (CustomRole with scope DEPARTMENT). Mirrors the exact pattern
 * components/admin/user-management.tsx already uses for the global role
 * dropdown (built-in options + custom CustomRole rows unified into one
 * list, `value`/`isCustom`/`customRoleId`/`enumRole` shape) — same idea,
 * department-scoped.
 *
 * DEPARTMENT_MANAGER (CustomRole.scope BOTH) is deliberately excluded from
 * the "custom" half below even though its scope isn't GLOBAL — it's already
 * present via the built-in half (DEPARTMENT_ROLE_OPTIONS), and including it
 * twice would show a duplicate row.
 */
import { prisma } from "@/lib/prisma";
import { DepartmentRole } from "@prisma/client";
import {
  DEPARTMENT_ROLE_OPTIONS,
  DEPARTMENT_ROLE_LABELS,
  DEPARTMENT_ROLE_DESCRIPTIONS,
} from "@/lib/services/department-role-translation";

export interface DepartmentRoleOption {
  /** Built-in: the DepartmentRole enum value itself (e.g. "AGENT_ASSIGNEE"). Custom: `custom:<CustomRole.id>`. */
  value: string;
  label: string;
  description?: string;
  isCustom: boolean;
  customRoleId?: string;
  /** The DepartmentRole enum value to store in DepartmentMembership.role — the real role when built-in, a required-but-unused VIEWER placeholder when custom. */
  enumRole: DepartmentRole;
}

const DEPARTMENT_ROLE_ENUM_VALUES = new Set<string>(DEPARTMENT_ROLE_OPTIONS as string[]);

export async function getDepartmentRoleOptions(): Promise<DepartmentRoleOption[]> {
  const builtIn: DepartmentRoleOption[] = DEPARTMENT_ROLE_OPTIONS.map((role) => ({
    value: role,
    label: DEPARTMENT_ROLE_LABELS[role],
    description: DEPARTMENT_ROLE_DESCRIPTIONS[role],
    isCustom: false,
    enumRole: role,
  }));

  const customRoles = await prisma.customRole.findMany({
    where: { scope: { not: "GLOBAL" }, isActive: true },
    orderBy: { name: "asc" },
  });

  const custom: DepartmentRoleOption[] = customRoles
    .filter((cr) => !DEPARTMENT_ROLE_ENUM_VALUES.has(cr.key))
    .map((cr) => ({
      value: `custom:${cr.id}`,
      label: cr.name,
      description: cr.description ?? undefined,
      isCustom: true,
      customRoleId: cr.id,
      enumRole: DepartmentRole.VIEWER,
    }));

  return [...builtIn, ...custom];
}
