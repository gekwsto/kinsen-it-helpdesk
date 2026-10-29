import { NextResponse } from "next/server";
import { SqlGeneralTreeSnapshotTrigger } from "@prisma/client";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { refreshSqlGeneralOrganizationTreeSnapshot } from "@/lib/services/sqlgeneral-tree-snapshot-service";
import { apiError, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

// POST /api/admin/organization/sqlgeneral-tree/refresh — ADMIN-gated
// manual rebuild of the persistent SQLGeneral tree snapshot. Same
// organization.sqlgeneralSync permission that already gates viewing the
// tree at all (GET /api/admin/organization/sqlgeneral-tree) — reaching
// this button already implies the caller can see the tree, so no
// separate permission key is introduced. `force: true`: a manual click
// always attempts a rebuild regardless of the daily staleness guard, but
// NEVER bypasses the snapshot's own lock — a click while a refresh is
// already running (CRON or another manual click) is reported 409, never
// started concurrently.
export async function POST() {
  try {
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "organization.sqlgeneralSync", session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You do not have permission to refresh the SQLGeneral organization tree.");

    const result = await refreshSqlGeneralOrganizationTreeSnapshot({ trigger: SqlGeneralTreeSnapshotTrigger.MANUAL, triggeredById: session.user.id, force: true });

    if (result.skipped) {
      return NextResponse.json(apiError("refresh_already_running", result.skipReason ?? "A refresh is already running."), { status: 409 });
    }
    if (!result.ok) {
      return NextResponse.json(apiError("sqlgeneral_tree_refresh_failed", result.reason ?? "The SQLGeneral tree refresh failed."), { status: 502 });
    }
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/admin/organization/sqlgeneral-tree/refresh] failed", error);
    return internalErrorResponse();
  }
}
