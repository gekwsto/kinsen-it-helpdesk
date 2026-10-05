import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { projectRequestTypeSchema } from "@/lib/validations";
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
    const parsed = projectRequestTypeSchema.partial().safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    if (parsed.data.name) {
      const existing = await prisma.projectRequestType.findUnique({ where: { name: parsed.data.name }, select: { id: true } });
      if (existing && existing.id !== id) {
        return NextResponse.json(apiError("name_taken", "A Project Request Type with this name already exists.", { field: "name" }), { status: 409 });
      }
    }

    const type = await prisma.projectRequestType.update({
      where: { id },
      data: parsed.data,
      include: { _count: { select: { projectRequests: true } } },
    });
    return NextResponse.json(type);
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (error.message === "Forbidden") return forbiddenResponse("You do not have permission to manage Project Request Types.");
    if (error.code === "P2025") return NextResponse.json(apiError("item_not_found", "This Project Request Type no longer exists."), { status: 404 });
    console.error("[api/admin/project-request-types/[id]] PATCH failed", error);
    return internalErrorResponse();
  }
}

// Hard delete, blocked while any ProjectRequest still references this type
// (409 item_in_use) — matching Cancel Reasons' own "hard-when-unused"
// semantics. Deactivate (PATCH isActive:false) is the reversible, always-
// available action; this is for removing a type that was never actually
// used.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSettingsAccess();
    const { id } = await params;

    const existing = await prisma.projectRequestType.findUnique({
      where: { id },
      include: { _count: { select: { projectRequests: true } } },
    });
    if (!existing) return NextResponse.json(apiError("item_not_found", "This Project Request Type no longer exists."), { status: 404 });

    if (existing._count.projectRequests > 0) {
      return NextResponse.json(
        apiError("item_in_use", `This type is used by ${existing._count.projectRequests} Project Request(s) and cannot be deleted. Deactivate it instead.`),
        { status: 409 }
      );
    }

    await prisma.projectRequestType.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (error.message === "Forbidden") return forbiddenResponse("You do not have permission to manage Project Request Types.");
    if (error.code === "P2003") {
      return NextResponse.json(apiError("item_in_use", "This type is still referenced and cannot be deleted. Deactivate it instead."), { status: 409 });
    }
    console.error("[api/admin/project-request-types/[id]] DELETE failed", error);
    return internalErrorResponse();
  }
}
