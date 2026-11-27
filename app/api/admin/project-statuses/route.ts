import { NextRequest, NextResponse } from "next/server";
import { Role } from "@prisma/client";
import { requireAuth } from "@/lib/permissions";
import { apiError, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";
import { createProjectStatusDefinition, getProjectStatusUsageCounts, listProjectStatusDefinitions } from "@/lib/services/project-status-service";
import { publishProjectListInvalidation } from "@/lib/realtime/project-list-invalidation";

/**
 * Administration -> Project Statuses (ADMIN only). One GLOBAL set of
 * configured Project Statuses — see lib/services/project-status-service.ts.
 *  GET  -> every definition (display order) + its Project usage count
 *  POST -> create a CUSTOM status { label, color?, sortOrder?, canonicalStatus, key?, isActive? }
 */
async function requireAdmin() {
  const session = await requireAuth();
  return session.user.role === Role.ADMIN ? session : null;
}

export async function GET() {
  try {
    if (!(await requireAdmin())) return forbiddenResponse("Only administrators can manage Project Statuses.");
    const [definitions, usage] = await Promise.all([listProjectStatusDefinitions(), getProjectStatusUsageCounts()]);
    return NextResponse.json(definitions.map((d) => ({ ...d, usageCount: usage[d.id] ?? 0 })));
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/admin/project-statuses] GET failed", error);
    return internalErrorResponse();
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!(await requireAdmin())) return forbiddenResponse("Only administrators can manage Project Statuses.");
    const body = await req.json().catch(() => ({}));
    const result = await createProjectStatusDefinition(body ?? {});
    if (!result.ok) return NextResponse.json(apiError(result.error.code, result.error.message), { status: result.error.status });
    publishProjectListInvalidation();
    return NextResponse.json({ ...result.definition, usageCount: 0 }, { status: 201 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/admin/project-statuses] POST failed", error);
    return internalErrorResponse();
  }
}
