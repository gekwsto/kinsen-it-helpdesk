import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { unauthorizedResponse, internalErrorResponse } from "@/lib/api-errors";
import { listProjectStatusDefinitions } from "@/lib/services/project-status-service";

/**
 * GET /api/project-statuses — the global configured Project Statuses
 * (display order, inactive included and flagged) for any signed-in user:
 * status pickers offer the ACTIVE ones (plus a Project's current one), and
 * displays need the inactive ones too. Read-only; managed only through the
 * ADMIN-only /api/admin/project-statuses.
 */
export async function GET() {
  try {
    await requireAuth();
    return NextResponse.json(await listProjectStatusDefinitions());
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/project-statuses] GET failed", error);
    return internalErrorResponse();
  }
}
