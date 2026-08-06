import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { getPeopleTree } from "@/lib/services/organization-tree-service";
import { canViewFullOrganizationTree, getOwnPeopleTreeSlice } from "@/lib/services/organization-scope-service";
import { unauthorizedResponse, internalErrorResponse } from "@/lib/api-errors";

// GET /api/organization/people-tree?rootUserId=&activeOnly=true|false
// `rootUserId` is only honored for a caller with full-tree access — a
// restricted caller always gets their OWN slice regardless of what
// rootUserId they pass, so this endpoint can never be used to walk an
// arbitrary user's subtree without permission.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth();
    const rootUserId = req.nextUrl.searchParams.get("rootUserId") ?? undefined;
    const activeOnlyParam = req.nextUrl.searchParams.get("activeOnly");
    const activeOnly = activeOnlyParam !== "false";

    const fullAccess = await canViewFullOrganizationTree(session.user.role, session.user.customRoleId);
    const tree = fullAccess
      ? await getPeopleTree(rootUserId, { activeOnly })
      : await getOwnPeopleTreeSlice(session.user.id);

    return NextResponse.json({ tree, fullAccess });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/organization/people-tree] failed", error);
    return internalErrorResponse();
  }
}
