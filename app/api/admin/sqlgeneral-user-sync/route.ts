import { NextRequest, NextResponse } from "next/server";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { requestManualSqlGeneralUserSyncRefresh, requestManualSqlGeneralUserSyncRefreshAll } from "@/lib/services/sqlgeneral-user-sync-service";
import { apiError, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

// POST /api/admin/sqlgeneral-user-sync — explicit admin "Sync N" ({ userId })
// or "Sync All" ({ all: true }) refresh request for the SQLGeneral per-user
// sync-state rows (lib/services/sqlgeneral-user-sync-service.ts). Gated on
// organization.sqlgeneralSync (see prisma/seed.ts); ADMIN bypasses via
// hasPermission() unconditionally. Only ever resets a terminal row
// (SUCCEEDED/FAILED_PERMANENT/SKIPPED_NO_USERNAME) back to PENDING — never
// disturbs one already PENDING/PROCESSING, and never performs any real
// SQLGeneral write itself (that's the worker's job, still gated on
// SQLGENERAL_SYNC_ENABLED).
export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "organization.sqlgeneralSync", session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You do not have permission to trigger a SQLGeneral organization sync refresh.");

    const body = await req.json().catch(() => null);
    if (body?.all === true) {
      const result = await requestManualSqlGeneralUserSyncRefreshAll();
      return NextResponse.json(result);
    }
    if (typeof body?.userId === "string" && body.userId.trim()) {
      const result = await requestManualSqlGeneralUserSyncRefresh(body.userId.trim());
      return NextResponse.json(result);
    }
    return NextResponse.json(apiError("invalid_request", "Provide either { userId } or { all: true }."), { status: 400 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/admin/sqlgeneral-user-sync] failed", error);
    return internalErrorResponse();
  }
}
