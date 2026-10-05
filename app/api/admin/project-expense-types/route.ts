import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { projectExpenseTypeSchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

// Project Expense Types are a single GLOBAL reference list (no department
// scope — every request-origin Project's setup form shares the same
// dropdown), structurally the same shape as Project Request Types. Gated
// by the existing `admin.access` permission, same rationale as
// /api/admin/project-request-types.
async function requireSettingsAccess() {
  const session = await requireAuth();
  const allowed = await hasPermission(session.user.role, "admin.access", session.user.customRoleId);
  if (!allowed) throw new Error("Forbidden");
  return session;
}

// GET — every type, active and inactive (an admin visibility view, not the
// setup form's own active-only dropdown — see /api/project-expense-types).
export async function GET() {
  try {
    await requireSettingsAccess();
    const types = await prisma.projectExpenseType.findMany({
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { projects: true } } },
    });
    return NextResponse.json(types);
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (error.message === "Forbidden") return forbiddenResponse("You do not have permission to manage Project Expense Types.");
    console.error("[api/admin/project-expense-types] GET failed", error);
    return internalErrorResponse();
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireSettingsAccess();
    const body = await req.json();
    const parsed = projectExpenseTypeSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    const existing = await prisma.projectExpenseType.findUnique({ where: { name: parsed.data.name }, select: { id: true } });
    if (existing) {
      return NextResponse.json(apiError("name_taken", "A Project Expense Type with this name already exists.", { field: "name" }), { status: 409 });
    }

    const type = await prisma.projectExpenseType.create({
      data: { name: parsed.data.name, isActive: parsed.data.isActive ?? true },
    });
    return NextResponse.json({ ...type, _count: { projects: 0 } }, { status: 201 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (error.message === "Forbidden") return forbiddenResponse("You do not have permission to manage Project Expense Types.");
    console.error("[api/admin/project-expense-types] POST failed", error);
    return internalErrorResponse();
  }
}
