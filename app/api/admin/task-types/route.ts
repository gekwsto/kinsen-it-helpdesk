import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { taskTypeSchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

// Task Types (formerly "Project Request Types" — see TaskType in
// prisma/schema.prisma for the full move from a ProjectRequest-only
// classification to an Activity one) are a single GLOBAL reference list
// (no department scope — every requester shares the same dropdown, and
// now every Activity creator does too), structurally the same shape as
// Task Sub Types. Gated by its OWN dedicated `projectRequestType.manage`
// permission — the permission KEY is deliberately UNCHANGED by this
// rename (renaming it would orphan existing RolePermission grants); NOT
// bare `admin.access`. See GLOBAL_ONLY_PERMISSION_KEYS in
// app/api/admin/roles/[id]/permissions/[permId]/route.ts and
// app/(main)/admin/roles/page.tsx.
async function requireTaskTypeManageAccess() {
  const session = await requireAuth();
  const allowed = await hasPermission(session.user.role, "projectRequestType.manage", session.user.customRoleId);
  if (!allowed) throw new Error("Forbidden");
  return session;
}

// GET — every type, active and inactive (an admin visibility view, not the
// form's own active-only dropdown — see /api/task-types). `_count` reports
// BOTH historical ProjectRequest usage and current Activity usage — see
// DELETE below for why both matter.
export async function GET() {
  try {
    await requireTaskTypeManageAccess();
    const types = await prisma.taskType.findMany({
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { projectRequests: true, activities: true } } },
    });
    return NextResponse.json(types);
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (error.message === "Forbidden") return forbiddenResponse("You do not have permission to manage Task Types.");
    console.error("[api/admin/task-types] GET failed", error);
    return internalErrorResponse();
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireTaskTypeManageAccess();
    const body = await req.json();
    const parsed = taskTypeSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    const existing = await prisma.taskType.findUnique({ where: { name: parsed.data.name }, select: { id: true } });
    if (existing) {
      return NextResponse.json(apiError("name_taken", "A Task Type with this name already exists.", { field: "name" }), { status: 409 });
    }

    const type = await prisma.taskType.create({
      data: { name: parsed.data.name, isActive: parsed.data.isActive ?? true },
    });
    return NextResponse.json({ ...type, _count: { projectRequests: 0, activities: 0 } }, { status: 201 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (error.message === "Forbidden") return forbiddenResponse("You do not have permission to manage Task Types.");
    console.error("[api/admin/task-types] POST failed", error);
    return internalErrorResponse();
  }
}
