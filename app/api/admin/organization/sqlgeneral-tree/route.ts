import { NextResponse } from "next/server";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { getLatestSuccessfulSqlGeneralTreeSnapshot, type TreeSnapshotPayload } from "@/lib/services/sqlgeneral-tree-snapshot-service";
import { unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

// GET /api/admin/organization/sqlgeneral-tree — read-only, admin-only
// (organization.sqlgeneralSync, same permission as every other SQLGeneral
// admin surface). Returns the SQLGeneral-sourced, MANAGER-FIRST tree built
// from UsersAndManagers.managerAMAccountName relationships — Company/
// Department are employee metadata only, never a hierarchy boundary.
// Completely independent of the canonical local tree
// (/api/organization/department-tree, unchanged) and never dependent on
// any approved SqlGeneralCompanyMapping/SqlGeneralDepartmentMapping to
// render. unresolvedUsers/unresolvedManagerLinks are always returned
// explicitly — never silently dropped.
//
// Reads ONLY the persistent snapshot (lib/services/sqlgeneral-tree-snapshot-service.ts)
// — ZERO SQLGeneral API calls on a normal page load. The tree itself is
// rebuilt separately, once a day, by the CRON worker or an ADMIN's manual
// Refresh (POST .../refresh). If no snapshot has EVER succeeded yet, this
// returns `{ initialized: false }` rather than silently falling back to a
// live fetch — the UI shows an explicit "not yet initialized" state.
export async function GET() {
  try {
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "organization.sqlgeneralSync", session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You do not have permission to view the SQLGeneral organization tree.");

    const snapshot = await getLatestSuccessfulSqlGeneralTreeSnapshot();
    if (!snapshot) return NextResponse.json({ initialized: false });

    const data = snapshot.treeData as unknown as TreeSnapshotPayload;
    return NextResponse.json({
      initialized: true,
      tree: data.roots,
      unresolvedUsers: data.unresolvedUsers,
      unresolvedManagerLinks: data.unresolvedManagerLinks,
      lastSuccessfulSyncAt: snapshot.completedAt,
    });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/admin/organization/sqlgeneral-tree] failed", error);
    return internalErrorResponse();
  }
}
