import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { getDepartmentRoleOptions } from "@/lib/services/department-role-options-service";

/**
 * Read-only list of department-role choices (built-in DepartmentRole values
 * + custom DEPARTMENT/BOTH-scope CustomRole rows) for the "Add Member" /
 * "Change Role" dropdowns. Deliberately gated by requireAuth() only, same as
 * GET /api/users — the actual grant is re-validated against
 * department.user.assign server-side on the write endpoint; seeing which
 * role names exist isn't sensitive on its own.
 */
export async function GET() {
  try {
    await requireAuth();
    const options = await getDepartmentRoleOptions();
    return NextResponse.json(options);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
