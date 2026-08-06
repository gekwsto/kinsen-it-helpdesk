import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { canViewFullOrganizationTree } from "@/lib/services/organization-scope-service";
import { getLatestOrganizationSyncRun, isOrganizationSyncRunning } from "@/lib/services/organization-sync-orchestrator";
import { unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

// GET /api/admin/organization/sync/status — last run + whether a sync is
// currently in progress, for the "Sync organization" button's pending state
// and the visualization page's "Last synchronized" timestamp. Readable by
// anyone with full-tree access (not sync-trigger-only) since it's the same
// audience that sees the visualization page itself.
export async function GET() {
  try {
    const session = await requireAuth();
    const allowed = await canViewFullOrganizationTree(session.user.role, session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You do not have permission to view organization sync status.");

    const [latestRun, running] = await Promise.all([getLatestOrganizationSyncRun(), isOrganizationSyncRunning()]);
    return NextResponse.json({ latestRun, running });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/admin/organization/sync/status] failed", error);
    return internalErrorResponse();
  }
}
