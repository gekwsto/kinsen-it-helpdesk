import { NextRequest, NextResponse } from "next/server";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { previewSqlGeneralUserSync } from "@/lib/services/sqlgeneral-user-sync-service";
import { apiError, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

// POST /api/admin/sqlgeneral-user-sync/preview — read-only "what would sync
// do" report for N users ({ userIds }) or all users with an existing
// sync-attempt row ({ all: true }). NEVER writes anything — see
// previewSqlGeneralUserSync's own doc comment — and deliberately NOT gated
// on SQLGENERAL_SYNC_ENABLED, so this can be used to inspect the outcome
// before that's ever flipped to "true". Same permission as the refresh
// endpoint (organization.sqlgeneralSync); ADMIN bypasses unconditionally.
export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "organization.sqlgeneralSync", session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You do not have permission to preview a SQLGeneral organization sync.");

    const body = await req.json().catch(() => null);
    const target = body?.all === true ? { all: true as const } : Array.isArray(body?.userIds) ? { userIds: body.userIds.filter((id: unknown) => typeof id === "string") } : null;
    if (!target) return NextResponse.json(apiError("invalid_request", "Provide either { userIds: string[] } or { all: true }."), { status: 400 });

    const result = await previewSqlGeneralUserSync(target);
    if (!result.ok) return NextResponse.json(apiError("sqlgeneral_unavailable", result.reason), { status: 502 });
    return NextResponse.json({ rows: result.rows });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/admin/sqlgeneral-user-sync/preview] failed", error);
    return internalErrorResponse();
  }
}
