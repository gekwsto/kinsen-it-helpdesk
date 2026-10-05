import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { activityTaskTypeSchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

async function requireTaskTypeManageAccess() {
  const session = await requireAuth();
  const allowed = await hasPermission(session.user.role, "taskType.manage", session.user.customRoleId);
  if (!allowed) throw new Error("Forbidden");
  return session;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireTaskTypeManageAccess();
    const { id } = await params;
    const body = await req.json();
    const parsed = activityTaskTypeSchema.partial().safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    if (parsed.data.name) {
      const existing = await prisma.activityTaskType.findUnique({ where: { name: parsed.data.name }, select: { id: true } });
      if (existing && existing.id !== id) {
        return NextResponse.json(apiError("name_taken", "A Task Type with this name already exists.", { field: "name" }), { status: 409 });
      }
    }

    // Changing the MASTER cost here is exactly the scenario this feature's
    // snapshot principle exists for: any Activity that already references
    // this Task Type keeps its own Activity.taskTypeCost untouched — this
    // update never reaches into ProjectActivity at all.
    const type = await prisma.activityTaskType.update({
      where: { id },
      data: parsed.data,
      include: { _count: { select: { activities: true } } },
    });
    return NextResponse.json({ ...type, cost: Number(type.cost) });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (error.message === "Forbidden") return forbiddenResponse("You do not have permission to manage Task Types.");
    if (error.code === "P2025") return NextResponse.json(apiError("item_not_found", "This Task Type no longer exists."), { status: 404 });
    console.error("[api/admin/activity-task-types/[id]] PATCH failed", error);
    return internalErrorResponse();
  }
}

// Hard delete, blocked while any Activity still references this type (409
// item_in_use) — never a cascading delete of the referencing Activities
// themselves (no orphaned/broken Activity history). Deactivate (PATCH
// isActive:false) is the reversible, always-available action; this is for
// removing a type that was never actually used.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireTaskTypeManageAccess();
    const { id } = await params;

    const existing = await prisma.activityTaskType.findUnique({
      where: { id },
      include: { _count: { select: { activities: true } } },
    });
    if (!existing) return NextResponse.json(apiError("item_not_found", "This Task Type no longer exists."), { status: 404 });

    if (existing._count.activities > 0) {
      return NextResponse.json(
        apiError("item_in_use", `This Task Type is used by ${existing._count.activities} Activity(ies) and cannot be deleted. Deactivate it instead.`),
        { status: 409 }
      );
    }

    await prisma.activityTaskType.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (error.message === "Forbidden") return forbiddenResponse("You do not have permission to manage Task Types.");
    if (error.code === "P2003") {
      return NextResponse.json(apiError("item_in_use", "This Task Type is still referenced and cannot be deleted. Deactivate it instead."), { status: 409 });
    }
    console.error("[api/admin/activity-task-types/[id]] DELETE failed", error);
    return internalErrorResponse();
  }
}
