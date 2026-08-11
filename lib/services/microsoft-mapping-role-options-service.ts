/**
 * The actual, live, database-backed role options for the Microsoft Mapping
 * dialog's "Global Role" and "Department Role" dropdowns — built-in enum
 * values UNION any active, non-built-in CustomRole of the matching scope,
 * minus the two roles a Microsoft mapping can never grant (Administrator /
 * Department Admin — unchanged policy, see
 * isGlobalRoleAllowedForMicrosoftMapping / isDepartmentRoleAllowedForMicrosoftMapping
 * in lib/services/department-role-translation.ts).
 *
 * Deliberately thin wrappers around the two general-purpose option services
 * (lib/services/global-role-options-service.ts,
 * lib/services/department-role-options-service.ts) rather than a third,
 * independent query — one authoritative union per scope, reused everywhere
 * a "pick a role" dropdown needs it, Microsoft Mapping included. A custom
 * role can never literally be "ADMIN"/"DEPARTMENT_ADMIN" (those are reserved
 * enum values POST /api/admin/roles can't produce — see
 * app/api/admin/roles/route.ts's key-uniqueness check against the built-in
 * mirrored CustomRole rows), so no extra "is this custom role privileged"
 * flag is needed — filtering out the two built-in options by value is
 * sufficient and exactly mirrors the two exclusion functions above.
 */
import { Role, DepartmentRole } from "@prisma/client";
import { getGlobalRoleOptions, type GlobalRoleOption } from "@/lib/services/global-role-options-service";
import { getDepartmentRoleOptions, type DepartmentRoleOption } from "@/lib/services/department-role-options-service";

export async function getMicrosoftMappingGlobalRoleOptions(): Promise<GlobalRoleOption[]> {
  const all = await getGlobalRoleOptions();
  return all.filter((o) => o.value !== Role.ADMIN);
}

export async function getMicrosoftMappingDepartmentRoleOptions(): Promise<DepartmentRoleOption[]> {
  const all = await getDepartmentRoleOptions();
  return all.filter((o) => o.value !== DepartmentRole.DEPARTMENT_ADMIN);
}
