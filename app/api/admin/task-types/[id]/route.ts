import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { taskTypeSchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

async function requireTaskTypeManageAccess() {
  const session = await requireAuth();
  const allowed = await hasPermission(session.user.role, "projectRequestType.manage", session.user.customRoleId);
  if (!allowed) throw new Error("Forbidden");
  return session;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireTaskTypeManageAccess();
    const { id } = await params;
    const body = await req.json();
    const parsed = taskTypeSchema.partial().safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    if (parsed.data.name) {
      const existing = await prisma.taskType.findUnique({ where: { name: parsed.data.name }, select: { id: true } });
      if (existing && existing.id !== id) {
        return NextResponse.json(apiError("name_taken", "A Task Type with this name already exists.", { field: "name" }), { status: 409 });
      }
    }

    const type = await prisma.taskType.update({
      where: { id },
      data: parsed.data,
      include: { _count: { select: { projectRequests: true, activities: true } } },
    });
    return NextResponse.json(type);
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (error.message === "Forbidden") return forbiddenResponse("You do not have permission to manage Task Types.");
    if (error.code === "P2025") return NextResponse.json(apiError("item_not_found", "This Task Type no longer exists."), { status: 404 });
    console.error("[api/admin/task-types/[id]] PATCH failed", error);
    return internalErrorResponse();
  }
}

// Hard delete, blocked while any ProjectRequest (historical) OR Activity
// (current) still references this type (409 item_in_use) — matching
// Cancel Reasons' own "hard-when-unused" semantics. Both relations matter
// now: the DB-level FK on ProjectActivity.taskTypeId is ON DELETE SET
// NULL, so without this application-level check a delete would silently
// strip the required classification off every Activity using it instead
// of erroring. Deactivate (PATCH isActive:false) is the reversible,
// always-available action; this is for removing a type that was never
// actually used.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireTaskTypeManageAccess();
    const { id } = await params;

    const existing = await prisma.taskType.findUnique({
      where: { id },
      include: { _count: { select: { projectRequests: true, activities: true } } },
    });
    if (!existing) return NextResponse.json(apiError("item_not_found", "This Task Type no longer exists."), { status: 404 });

    if (existing._count.projectRequests > 0 || existing._count.activities > 0) {
      const parts: string[] = [];
      if (existing._count.activities > 0) parts.push(`${existing._count.activities} Activity(ies)`);
      if (existing._count.projectRequests > 0) parts.push(`${existing._count.projectRequests} historical Project Request(s)`);
      return NextResponse.json(
        apiError("item_in_use", `This type is used by ${parts.join(" and ")} and cannot be deleted. Deactivate it instead.`),
        { status: 409 }
      );
    }

    await prisma.taskType.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (error.message === "Forbidden") return forbiddenResponse("You do not have permission to manage Task Types.");
    if (error.code === "P2003") {
      return NextResponse.json(apiError("item_in_use", "This type is still referenced and cannot be deleted. Deactivate it instead."), { status: 409 });
    }
    console.error("[api/admin/task-types/[id]] DELETE failed", error);
    return internalErrorResponse();
  }
}
