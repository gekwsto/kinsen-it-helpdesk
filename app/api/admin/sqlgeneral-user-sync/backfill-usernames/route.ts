import { NextRequest, NextResponse } from "next/server";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { previewSqlGeneralUsernameBackfill, applySqlGeneralUsernameBackfill } from "@/lib/services/sqlgeneral-user-sync-service";
import { apiError, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

// POST /api/admin/sqlgeneral-user-sync/backfill-usernames — { apply?: boolean }
// (default false = preview only). Retrieves onPremisesSamAccountName for
// EXISTING Microsoft-linked users via the existing app-only Graph directory
// mechanism (Directory.Read.All) — no new login required. Matches
// exclusively by Graph id -> User.microsoftUserId. Never creates, deletes,
// or modifies a User row; only ever writes to SqlGeneralUserSyncAttempt,
// and only for the two provably-safe actions (create_pending/
// recover_pending) — see previewSqlGeneralUsernameBackfill/
// applySqlGeneralUsernameBackfill's own doc comments for the full
// safety rules (active/terminal rows and conflicting usernames are never
// touched). Same permission as the other SQLGeneral admin actions.
export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "organization.sqlgeneralSync", session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You do not have permission to run a SQLGeneral username backfill.");

    const body = await req.json().catch(() => null);
    const apply = body?.apply === true;

    if (apply) {
      const result = await applySqlGeneralUsernameBackfill();
      if (!result.ok) return NextResponse.json(apiError("backfill_unavailable", result.reason), { status: 502 });
      return NextResponse.json({ applied: result.applied, counts: result.counts });
    }
    const result = await previewSqlGeneralUsernameBackfill();
    if (!result.ok) return NextResponse.json(apiError("backfill_unavailable", result.reason), { status: 502 });
    return NextResponse.json({ candidates: result.candidates, counts: result.counts });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/admin/sqlgeneral-user-sync/backfill-usernames] failed", error);
    return internalErrorResponse();
  }
}
