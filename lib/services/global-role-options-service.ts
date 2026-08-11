/**
 * Unified list of GLOBAL-role choices for any "assign a global role"
 * dropdown — the 5 built-in Role enum values, plus any admin-created custom
 * global role (CustomRole scope GLOBAL/BOTH). Mirrors
 * lib/services/department-role-options-service.ts's exact pattern
 * (`value`/`isCustom`/`customRoleId`/`enumRole` shape) — same idea, global
 * scope instead of department scope. Centralizing this here (rather than
 * leaving it inline in components/admin/user-management.tsx, which built
 * its own equivalent union client-side) is what lets Microsoft Mapping's
 * Global Role dropdown share one authoritative source with every other
 * "pick a global role" surface, instead of each consumer re-deriving the
 * built-in+custom union its own way.
 */
import { prisma } from "@/lib/prisma";
import { Role } from "@prisma/client";
import { GLOBAL_ROLE_LABELS, GLOBAL_ROLE_DESCRIPTIONS } from "@/lib/services/department-role-translation";

export interface GlobalRoleOption {
  /** Built-in: the Role enum value itself (e.g. "IT_AGENT"). Custom: `custom:<CustomRole.id>`. */
  value: string;
  label: string;
  description?: string;
  isCustom: boolean;
  customRoleId?: string;
  /** The Role enum value to store in User.role — the real role when built-in, a required-but-unused USER placeholder when custom. */
  enumRole: Role;
}

const GLOBAL_ROLE_ENUM_VALUES = new Set<string>(Object.values(Role));

export async function getGlobalRoleOptions(): Promise<GlobalRoleOption[]> {
  const builtIn: GlobalRoleOption[] = Object.values(Role).map((role) => ({
    value: role,
    label: GLOBAL_ROLE_LABELS[role],
    description: GLOBAL_ROLE_DESCRIPTIONS[role],
    isCustom: false,
    enumRole: role,
  }));

  const customRoles = await prisma.customRole.findMany({
    where: { scope: { not: "DEPARTMENT" }, isActive: true },
    orderBy: { name: "asc" },
  });

  const custom: GlobalRoleOption[] = customRoles
    .filter((cr) => !cr.isBuiltIn && !GLOBAL_ROLE_ENUM_VALUES.has(cr.key))
    .map((cr) => ({
      value: `custom:${cr.id}`,
      label: cr.name,
      description: cr.description ?? undefined,
      isCustom: true,
      customRoleId: cr.id,
      enumRole: Role.USER,
    }));

  return [...builtIn, ...custom];
}
