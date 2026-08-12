import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { getDepartmentRoleOptions } from "@/lib/services/department-role-options-service";

/**
 * Read-only list of department-role choices (built-in DepartmentRole values
 * + custom DEPARTMENT/BOTH-scope CustomRole rows) for the "Add Member" /
 * "Change Role" dropdowns. Deliberately gated by requireAuth() only, same as
 * GET /api/users — the actual grant is re-validated against
 * department.user.assign server-side on the write endpoint; seeing which
 * role names exist isn't sensitive on its own.
 *
 * `?includeInactive=true` also returns disabled roles (each still carries
 * `isActive`) — used only by callers that need to correctly display an
 * EXISTING membership's current role even if it has since been disabled
 * (see getDepartmentRoleOptions's own doc comment). The default (omitted /
 * anything else) stays exactly the previous behavior: active roles only.
 */
export async function GET(req: NextRequest) {
  try {
    await requireAuth();
    const includeInactive = req.nextUrl.searchParams.get("includeInactive") === "true";
    const options = await getDepartmentRoleOptions({ includeInactive });
    return NextResponse.json(options);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
