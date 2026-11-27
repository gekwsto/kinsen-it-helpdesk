import { NextRequest, NextResponse } from "next/server";
import { Role } from "@prisma/client";
import { requireAuth } from "@/lib/permissions";
import { apiError, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";
import { deleteProjectStatusDefinition, getProjectStatusUsageCounts, updateProjectStatusDefinition } from "@/lib/services/project-status-service";
import { publishProjectListInvalidation } from "@/lib/realtime/project-list-invalidation";

/**
 * PATCH  -> edit label/color/sortOrder/isActive (any status) and
 *           canonicalStatus (CUSTOM + unused only). Key is immutable.
 * DELETE -> CUSTOM + unused only.
 * Rejections carry a clear message and, for in-use statuses, `usageCount`.
 */
async function requireAdmin() {
  const session = await requireAuth();
  return session.user.role === Role.ADMIN ? session : null;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!(await requireAdmin())) return forbiddenResponse("Only administrators can manage Project Statuses.");
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const result = await updateProjectStatusDefinition(id, body ?? {});
    if (!result.ok) {
      return NextResponse.json({ ...apiError(result.error.code, result.error.message), ...(result.error.usageCount !== undefined ? { usageCount: result.error.usageCount } : {}) }, { status: result.error.status });
    }
    publishProjectListInvalidation();
    const usage = await getProjectStatusUsageCounts();
    return NextResponse.json({ ...result.definition, usageCount: usage[id] ?? 0 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (String(error.message).includes("project_status_in_use")) {
      return NextResponse.json(apiError("status_in_use", "This status is used by Projects — its lifecycle state can't be changed."), { status: 409 });
    }
    console.error("[api/admin/project-statuses/[id]] PATCH failed", error);
    return internalErrorResponse();
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!(await requireAdmin())) return forbiddenResponse("Only administrators can manage Project Statuses.");
    const { id } = await params;
    const result = await deleteProjectStatusDefinition(id);
    if (!result.ok) {
      return NextResponse.json({ ...apiError(result.error.code, result.error.message), ...(result.error.usageCount !== undefined ? { usageCount: result.error.usageCount } : {}) }, { status: result.error.status });
    }
    publishProjectListInvalidation();
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (error.code === "P2003") {
      return NextResponse.json(apiError("status_in_use", "This status is used by Projects and can't be deleted."), { status: 409 });
    }
    console.error("[api/admin/project-statuses/[id]] DELETE failed", error);
    return internalErrorResponse();
  }
}
