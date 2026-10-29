import { NextResponse } from "next/server";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { getLatestSqlGeneralTreeSnapshotRun, getLatestSuccessfulSqlGeneralTreeSnapshot, isSqlGeneralTreeSnapshotRefreshRunning } from "@/lib/services/sqlgeneral-tree-snapshot-service";
import { unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

// GET /api/admin/organization/sqlgeneral-tree/status — same shape as the
// existing /api/admin/organization/sync/status route, backed by the
// SQLGeneral snapshot's own run history instead. `latestSuccessful` is
// what GET /api/admin/organization/sqlgeneral-tree is actually serving
// right now; `latestRun` can be a MORE RECENT, FAILED attempt — so the UI
// can show "last attempt failed" even while an older successful snapshot
// is still what's displayed.
export async function GET() {
  try {
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "organization.sqlgeneralSync", session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You do not have permission to view the SQLGeneral organization tree.");

    const [latestSuccessful, latestRun, running] = await Promise.all([
      getLatestSuccessfulSqlGeneralTreeSnapshot(),
      getLatestSqlGeneralTreeSnapshotRun(),
      isSqlGeneralTreeSnapshotRefreshRunning(),
    ]);

    return NextResponse.json({
      latestSuccessful: latestSuccessful
        ? {
            completedAt: latestSuccessful.completedAt,
            rootCount: latestSuccessful.rootCount,
            nodeCount: latestSuccessful.nodeCount,
            unresolvedUserCount: latestSuccessful.unresolvedUserCount,
            unresolvedManagerLinkCount: latestSuccessful.unresolvedManagerLinkCount,
          }
        : null,
      latestRun: latestRun
        ? { id: latestRun.id, status: latestRun.status, startedAt: latestRun.startedAt, completedAt: latestRun.completedAt, triggeredBy: latestRun.triggeredBy, lastError: latestRun.lastError }
        : null,
      running,
    });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/admin/organization/sqlgeneral-tree/status] failed", error);
    return internalErrorResponse();
  }
}
