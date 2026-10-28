import { NextRequest, NextResponse } from "next/server";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { previewSqlGeneralDepartmentMappingCandidate, approveSqlGeneralDepartmentMapping } from "@/lib/services/sqlgeneral-user-sync-service";
import { apiError, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

// GET  /api/admin/sqlgeneral-user-sync/department-mapping?sqlGeneralDepartmentId=&targetDepartmentId= — read-only candidate preview.
// POST /api/admin/sqlgeneral-user-sync/department-mapping { sqlGeneralDepartmentId, targetDepartmentId, confirmMultipleMapping? } — explicit admin approval.
// Mirrors the Company-mapping endpoints exactly. Never infers a mapping
// from a name match; approval requires the target Department's own
// Company to already have an approved Company mapping, and never writes
// to the target Department's own fields, ownership, or hierarchy. Same
// organization.sqlgeneralSync permission as every other SQLGeneral admin action.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "organization.sqlgeneralSync", session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You do not have permission to view a SQLGeneral Department mapping candidate.");

    const sqlGeneralDepartmentId = req.nextUrl.searchParams.get("sqlGeneralDepartmentId");
    const targetDepartmentId = req.nextUrl.searchParams.get("targetDepartmentId");
    if (!sqlGeneralDepartmentId || !targetDepartmentId) {
      return NextResponse.json(apiError("invalid_request", "Provide both sqlGeneralDepartmentId and targetDepartmentId query params."), { status: 400 });
    }

    const candidate = await previewSqlGeneralDepartmentMappingCandidate(sqlGeneralDepartmentId, targetDepartmentId);
    return NextResponse.json(candidate);
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/admin/sqlgeneral-user-sync/department-mapping] GET failed", error);
    return internalErrorResponse();
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "organization.sqlgeneralSync", session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You do not have permission to approve a SQLGeneral Department mapping.");

    const body = await req.json().catch(() => null);
    const sqlGeneralDepartmentId = typeof body?.sqlGeneralDepartmentId === "string" ? body.sqlGeneralDepartmentId.trim() : "";
    const targetDepartmentId = typeof body?.targetDepartmentId === "string" ? body.targetDepartmentId.trim() : "";
    if (!sqlGeneralDepartmentId || !targetDepartmentId) {
      return NextResponse.json(apiError("invalid_request", "Provide both sqlGeneralDepartmentId and targetDepartmentId."), { status: 400 });
    }
    const confirmMultipleMapping = body?.confirmMultipleMapping === true;

    const result = await approveSqlGeneralDepartmentMapping(sqlGeneralDepartmentId, targetDepartmentId, session.user.id, confirmMultipleMapping);
    if (!result.ok) return NextResponse.json(apiError("mapping_rejected", result.reason), { status: 409 });
    return NextResponse.json(result.mapping);
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/admin/sqlgeneral-user-sync/department-mapping] POST failed", error);
    return internalErrorResponse();
  }
}
