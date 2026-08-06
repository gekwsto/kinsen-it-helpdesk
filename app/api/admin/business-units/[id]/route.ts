import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { updateBusinessUnitSchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "businessUnit.update", session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You do not have permission to edit business units.");

    const body = await req.json();
    const parsed = updateBusinessUnitSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    if (parsed.data.companyId) {
      const company = await prisma.company.findUnique({ where: { id: parsed.data.companyId }, select: { id: true } });
      if (!company) {
        return NextResponse.json(apiError("invalid_company", "The selected company does not exist.", { field: "companyId" }), { status: 400 });
      }
    }

    const businessUnit = await prisma.businessUnit.update({
      where: { id },
      data: parsed.data,
      include: {
        company: { select: { id: true, name: true } },
        _count: { select: { departments: true, users: true, projects: true, activities: true } },
      },
    });
    return NextResponse.json(businessUnit);
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (error?.code === "P2025") return NextResponse.json(apiError("not_found", "Business unit not found."), { status: 404 });
    console.error("[api/admin/business-units/[id]] PATCH failed", error);
    return internalErrorResponse();
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "businessUnit.delete", session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You do not have permission to delete business units.");

    const businessUnit = await prisma.businessUnit.findUnique({
      where: { id },
      include: { _count: { select: { departments: true, users: true, projects: true, activities: true } } },
    });
    if (!businessUnit) return NextResponse.json(apiError("not_found", "Business unit not found."), { status: 404 });

    const counts = businessUnit._count;
    const totalDependents = Object.values(counts).reduce((sum, n) => sum + n, 0);
    if (totalDependents > 0) {
      const parts = Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([key, n]) => `${n} ${key}`)
        .join(", ");
      return NextResponse.json(
        apiError("has_dependents", `Cannot delete a business unit that still has ${parts}. Move or remove them first.`),
        { status: 409 }
      );
    }

    await prisma.businessUnit.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/admin/business-units/[id]] DELETE failed", error);
    return internalErrorResponse();
  }
}
