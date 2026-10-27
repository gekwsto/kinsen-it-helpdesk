import { NextRequest, NextResponse } from "next/server";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { previewSqlGeneralCompanyMappingCandidate, approveSqlGeneralCompanyMapping } from "@/lib/services/sqlgeneral-user-sync-service";
import { apiError, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

// GET  /api/admin/sqlgeneral-user-sync/company-mapping?sqlGeneralCompanyId=&targetCompanyId= — read-only candidate preview.
// POST /api/admin/sqlgeneral-user-sync/company-mapping { sqlGeneralCompanyId, targetCompanyId } — explicit admin approval.
// Never infers a mapping from a name match; approval only ever reads the
// target Company to confirm it exists, never writes to its own fields or
// ownership. Same organization.sqlgeneralSync permission as every other
// SQLGeneral admin action.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "organization.sqlgeneralSync", session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You do not have permission to view a SQLGeneral Company mapping candidate.");

    const sqlGeneralCompanyId = req.nextUrl.searchParams.get("sqlGeneralCompanyId");
    const targetCompanyId = req.nextUrl.searchParams.get("targetCompanyId");
    if (!sqlGeneralCompanyId || !targetCompanyId) {
      return NextResponse.json(apiError("invalid_request", "Provide both sqlGeneralCompanyId and targetCompanyId query params."), { status: 400 });
    }

    const candidate = await previewSqlGeneralCompanyMappingCandidate(sqlGeneralCompanyId, targetCompanyId);
    return NextResponse.json(candidate);
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/admin/sqlgeneral-user-sync/company-mapping] GET failed", error);
    return internalErrorResponse();
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "organization.sqlgeneralSync", session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You do not have permission to approve a SQLGeneral Company mapping.");

    const body = await req.json().catch(() => null);
    const sqlGeneralCompanyId = typeof body?.sqlGeneralCompanyId === "string" ? body.sqlGeneralCompanyId.trim() : "";
    const targetCompanyId = typeof body?.targetCompanyId === "string" ? body.targetCompanyId.trim() : "";
    if (!sqlGeneralCompanyId || !targetCompanyId) {
      return NextResponse.json(apiError("invalid_request", "Provide both sqlGeneralCompanyId and targetCompanyId."), { status: 400 });
    }
    const confirmMultipleMapping = body?.confirmMultipleMapping === true;

    const result = await approveSqlGeneralCompanyMapping(sqlGeneralCompanyId, targetCompanyId, session.user.id, confirmMultipleMapping);
    if (!result.ok) return NextResponse.json(apiError("mapping_rejected", result.reason), { status: 409 });
    return NextResponse.json(result.mapping);
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/admin/sqlgeneral-user-sync/company-mapping] POST failed", error);
    return internalErrorResponse();
  }
}
