import { NextRequest, NextResponse } from "next/server";
import { requireAuth, canManageAnyRoles } from "@/lib/permissions";
import {
  getDefaultRoleConfig,
  setDefaultGlobalRole,
  setDefaultDepartmentRole,
  DefaultRoleConfigValidationError,
} from "@/lib/services/default-role-service";
import { z } from "zod";

// Same gate as GET/POST /api/admin/roles — Default Roles is a section of
// the same Roles & Permissions admin surface, not a separate permission.
async function requireRoleManagementAccess() {
  const session = await requireAuth();
  const allowed = await canManageAnyRoles(session.user.role, session.user.customRoleId);
  if (!allowed) throw new Error("forbidden");
}

export async function GET() {
  try {
    await requireRoleManagementAccess();
    const config = await getDefaultRoleConfig();
    return NextResponse.json(config);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}

const updateDefaultRolesSchema = z.object({
  // Explicit null clears the default; omitted leaves that half unchanged —
  // the two defaults are independently settable, matching the two separate
  // Select controls in the admin UI.
  defaultGlobalCustomRoleId: z.string().nullable().optional(),
  defaultDepartmentCustomRoleId: z.string().nullable().optional(),
});

export async function PATCH(req: NextRequest) {
  try {
    await requireRoleManagementAccess();
    const body = await req.json();
    const data = updateDefaultRolesSchema.parse(body);

    if (data.defaultGlobalCustomRoleId !== undefined) {
      await setDefaultGlobalRole(data.defaultGlobalCustomRoleId);
    }
    if (data.defaultDepartmentCustomRoleId !== undefined) {
      await setDefaultDepartmentRole(data.defaultDepartmentCustomRoleId);
    }

    const config = await getDefaultRoleConfig();
    return NextResponse.json(config);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    if (error instanceof DefaultRoleConfigValidationError) {
      return NextResponse.json({ error: error.message, code: error.reason }, { status: 422 });
    }
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}
