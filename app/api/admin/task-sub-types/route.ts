import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { taskSubTypeSchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

// Task Sub Types (formerly "Activity Task Types" — see TaskSubType in
// prisma/schema.prisma) are a single GLOBAL reference list (no department
// scope — every Activity creation form shares the same dropdown),
// structurally the same shape as Project Expense Types, but gated by its
// OWN dedicated `taskType.manage` permission rather than bare
// `admin.access` — the permission KEY is deliberately UNCHANGED by this
// rename (renaming it would orphan existing RolePermission grants);
// hiding the admin menu entry is not authorization, this is re-checked
// here, server-side, on every mutation.
async function requireTaskSubTypeManageAccess() {
  const session = await requireAuth();
  const allowed = await hasPermission(session.user.role, "taskType.manage", session.user.customRoleId);
  if (!allowed) throw new Error("Forbidden");
  return session;
}

// GET — every type, active and inactive (an admin visibility view, not the
// Activity creation form's own active-only dropdown — see
// /api/task-sub-types). cost is nullable now — `null` means "no fixed
// configured cost" and must NEVER be coerced to 0 on its way to the wire
// (Number(null) === 0 would silently fabricate a cost that was never
// configured).
export async function GET() {
  try {
    await requireTaskSubTypeManageAccess();
    const types = await prisma.taskSubType.findMany({
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { activities: true } } },
    });
    return NextResponse.json(types.map((t) => ({ ...t, cost: t.cost === null ? null : Number(t.cost) })));
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (error.message === "Forbidden") return forbiddenResponse("You do not have permission to manage Task Sub Types.");
    console.error("[api/admin/task-sub-types] GET failed", error);
    return internalErrorResponse();
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireTaskSubTypeManageAccess();
    const body = await req.json();
    const parsed = taskSubTypeSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    const existing = await prisma.taskSubType.findUnique({ where: { name: parsed.data.name }, select: { id: true } });
    if (existing) {
      return NextResponse.json(apiError("name_taken", "A Task Sub Type with this name already exists.", { field: "name" }), { status: 409 });
    }

    // cost may be genuinely absent/null — some Task Sub Types (e.g.
    // "Others", "External") have no fixed predefined cost. Explicitly
    // written as null, never defaulted to 0.
    const costValue = parsed.data.cost ?? null;
    const type = await prisma.taskSubType.create({
      data: { name: parsed.data.name, cost: costValue, isActive: parsed.data.isActive ?? true },
    });
    return NextResponse.json({ ...type, cost: type.cost === null ? null : Number(type.cost), _count: { activities: 0 } }, { status: 201 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (error.message === "Forbidden") return forbiddenResponse("You do not have permission to manage Task Sub Types.");
    console.error("[api/admin/task-sub-types] POST failed", error);
    return internalErrorResponse();
  }
}
