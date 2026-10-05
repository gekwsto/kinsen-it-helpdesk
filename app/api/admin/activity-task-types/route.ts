import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { activityTaskTypeSchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

// Activity Task Types are a single GLOBAL reference list (no department
// scope — every request-origin Activity's creation form shares the same
// dropdown), structurally the same shape as Project Expense Types, but
// gated by its OWN dedicated `taskType.manage` permission rather than bare
// `admin.access` — hiding the admin menu entry is not authorization; this
// is re-checked here, server-side, on every mutation.
async function requireTaskTypeManageAccess() {
  const session = await requireAuth();
  const allowed = await hasPermission(session.user.role, "taskType.manage", session.user.customRoleId);
  if (!allowed) throw new Error("Forbidden");
  return session;
}

// GET — every type, active and inactive (an admin visibility view, not the
// Activity creation form's own active-only dropdown — see
// /api/activity-task-types).
export async function GET() {
  try {
    await requireTaskTypeManageAccess();
    const types = await prisma.activityTaskType.findMany({
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { activities: true } } },
    });
    // Decimal -> plain number for the wire, same convention as every other
    // money-bearing admin list in this repo (Project Budget/Estimated/
    // Actual Cost).
    return NextResponse.json(types.map((t) => ({ ...t, cost: Number(t.cost) })));
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (error.message === "Forbidden") return forbiddenResponse("You do not have permission to manage Task Types.");
    console.error("[api/admin/activity-task-types] GET failed", error);
    return internalErrorResponse();
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireTaskTypeManageAccess();
    const body = await req.json();
    const parsed = activityTaskTypeSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    const existing = await prisma.activityTaskType.findUnique({ where: { name: parsed.data.name }, select: { id: true } });
    if (existing) {
      return NextResponse.json(apiError("name_taken", "A Task Type with this name already exists.", { field: "name" }), { status: 409 });
    }

    const type = await prisma.activityTaskType.create({
      data: { name: parsed.data.name, cost: parsed.data.cost, isActive: parsed.data.isActive ?? true },
    });
    return NextResponse.json({ ...type, cost: Number(type.cost), _count: { activities: 0 } }, { status: 201 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (error.message === "Forbidden") return forbiddenResponse("You do not have permission to manage Task Types.");
    console.error("[api/admin/activity-task-types] POST failed", error);
    return internalErrorResponse();
  }
}
