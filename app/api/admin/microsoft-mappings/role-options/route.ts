import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/permissions";
import {
  getMicrosoftMappingGlobalRoleOptions,
  getMicrosoftMappingDepartmentRoleOptions,
} from "@/lib/services/microsoft-mapping-role-options-service";

/**
 * Live role choices for the Microsoft Mapping dialog's Global Role /
 * Department Role dropdowns — built-in roles plus any active custom role of
 * the matching scope, straight from the database (never a build-time
 * constant), so a role created moments ago in Roles & Permissions appears
 * immediately. Gated by requireAdmin(), same as every other
 * /api/admin/microsoft-mappings/** route — this is part of managing
 * mappings, not a broader "list roles" surface.
 */
export async function GET() {
  try {
    await requireAdmin();
    const [globalRoles, departmentRoles] = await Promise.all([
      getMicrosoftMappingGlobalRoleOptions(),
      getMicrosoftMappingDepartmentRoleOptions(),
    ]);
    return NextResponse.json({ globalRoles, departmentRoles });
  } catch {
    return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
  }
}
