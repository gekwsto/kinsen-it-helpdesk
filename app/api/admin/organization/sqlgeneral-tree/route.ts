import { NextResponse } from "next/server";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { getSqlGeneralOrganizationTree } from "@/lib/services/sqlgeneral-organization-tree-service";
import { apiError, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

// GET /api/admin/organization/sqlgeneral-tree — read-only, admin-only
// (organization.sqlgeneralSync, same permission as every other SQLGeneral
// admin surface). Returns the SQLGeneral-sourced tree built from
// Departments.ParentDepartmentId with existing TicketApp users as leaves —
// completely independent of the canonical local tree
// (/api/organization/department-tree, unchanged) and never dependent on
// any approved SqlGeneralCompanyMapping/SqlGeneralDepartmentMapping to
// render. unresolvedDepartments/unresolvedUsers/unresolvedCompanyIdentity
// are always returned explicitly — never silently dropped.
export async function GET() {
  try {
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "organization.sqlgeneralSync", session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You do not have permission to view the SQLGeneral organization tree.");

    const result = await getSqlGeneralOrganizationTree();
    if (!result.ok) return NextResponse.json(apiError("sqlgeneral_tree_unavailable", result.reason), { status: 502 });
    return NextResponse.json({
      tree: result.roots,
      unresolvedDepartments: result.unresolvedDepartments,
      unresolvedUsers: result.unresolvedUsers,
      unresolvedCompanyIdentity: result.unresolvedCompanyIdentity,
    });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/admin/organization/sqlgeneral-tree] failed", error);
    return internalErrorResponse();
  }
}
