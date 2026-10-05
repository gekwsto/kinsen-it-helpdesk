import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { projectExpenseTypeSchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

async function requireSettingsAccess() {
  const session = await requireAuth();
  const allowed = await hasPermission(session.user.role, "admin.access", session.user.customRoleId);
  if (!allowed) throw new Error("Forbidden");
  return session;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSettingsAccess();
    const { id } = await params;
    const body = await req.json();
    const parsed = projectExpenseTypeSchema.partial().safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    if (parsed.data.name) {
      const existing = await prisma.projectExpenseType.findUnique({ where: { name: parsed.data.name }, select: { id: true } });
      if (existing && existing.id !== id) {
        return NextResponse.json(apiError("name_taken", "A Project Expense Type with this name already exists.", { field: "name" }), { status: 409 });
      }
    }

    const type = await prisma.projectExpenseType.update({
      where: { id },
      data: parsed.data,
      include: { _count: { select: { projects: true } } },
    });
    return NextResponse.json(type);
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (error.message === "Forbidden") return forbiddenResponse("You do not have permission to manage Project Expense Types.");
    if (error.code === "P2025") return NextResponse.json(apiError("item_not_found", "This Project Expense Type no longer exists."), { status: 404 });
    console.error("[api/admin/project-expense-types/[id]] PATCH failed", error);
    return internalErrorResponse();
  }
}

// Hard delete, blocked while any Project still references this type (409
// item_in_use) — matching Project Request Types' own "hard-when-unused"
// semantics. Deactivate (PATCH isActive:false) is the reversible,
// always-available action; this is for removing a type that was never
// actually used. Never a cascading delete of the referencing Projects
// themselves.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSettingsAccess();
    const { id } = await params;

    const existing = await prisma.projectExpenseType.findUnique({
      where: { id },
      include: { _count: { select: { projects: true } } },
    });
    if (!existing) return NextResponse.json(apiError("item_not_found", "This Project Expense Type no longer exists."), { status: 404 });

    if (existing._count.projects > 0) {
      return NextResponse.json(
        apiError("item_in_use", `This type is used by ${existing._count.projects} Project(s) and cannot be deleted. Deactivate it instead.`),
        { status: 409 }
      );
    }

    await prisma.projectExpenseType.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (error.message === "Forbidden") return forbiddenResponse("You do not have permission to manage Project Expense Types.");
    if (error.code === "P2003") {
      return NextResponse.json(apiError("item_in_use", "This type is still referenced and cannot be deleted. Deactivate it instead."), { status: 409 });
    }
    console.error("[api/admin/project-expense-types/[id]] DELETE failed", error);
    return internalErrorResponse();
  }
}
