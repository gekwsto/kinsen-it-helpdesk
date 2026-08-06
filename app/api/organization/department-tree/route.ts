import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { getDepartmentTree } from "@/lib/services/organization-tree-service";
import { canViewFullOrganizationTree, getOwnDepartmentTreeSlice } from "@/lib/services/organization-scope-service";
import { unauthorizedResponse, internalErrorResponse } from "@/lib/api-errors";

// GET /api/organization/department-tree?activeOnly=true|false
// Full tree for Admin/Director/anyone with organization.tree.view; every
// other authenticated user gets just their own department's ancestor path
// (never a 403 for a plain user — a smaller, real, non-empty response
// instead, per the brief's "simple users can see at least their own
// department" requirement).
export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth();
    const activeOnlyParam = req.nextUrl.searchParams.get("activeOnly");
    const activeOnly = activeOnlyParam !== "false";

    const fullAccess = await canViewFullOrganizationTree(session.user.role, session.user.customRoleId);
    const tree = fullAccess
      ? await getDepartmentTree({ activeOnly })
      : await getOwnDepartmentTreeSlice(session.user.id);

    return NextResponse.json({ tree, fullAccess });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/organization/department-tree] failed", error);
    return internalErrorResponse();
  }
}
