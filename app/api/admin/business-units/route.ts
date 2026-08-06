import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { createBusinessUnitSchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

export async function GET() {
  try {
    const session = await requireAuth();
    const allowed =
      (await hasPermission(session.user.role, "businessUnit.create", session.user.customRoleId)) ||
      (await hasPermission(session.user.role, "businessUnit.update", session.user.customRoleId)) ||
      (await hasPermission(session.user.role, "businessUnit.delete", session.user.customRoleId));
    if (!allowed) return forbiddenResponse("You do not have permission to view business units.");

    const businessUnits = await prisma.businessUnit.findMany({
      orderBy: { name: "asc" },
      include: {
        company: { select: { id: true, name: true } },
        _count: { select: { departments: true, users: true, projects: true, activities: true } },
      },
    });
    return NextResponse.json(businessUnits);
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/admin/business-units] GET failed", error);
    return internalErrorResponse();
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "businessUnit.create", session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You do not have permission to create business units.");

    const body = await req.json();
    const parsed = createBusinessUnitSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    const company = await prisma.company.findUnique({ where: { id: parsed.data.companyId }, select: { id: true } });
    if (!company) {
      return NextResponse.json(apiError("invalid_company", "The selected company does not exist.", { field: "companyId" }), { status: 400 });
    }

    const businessUnit = await prisma.businessUnit.create({ data: parsed.data });
    const withRelations = await prisma.businessUnit.findUnique({
      where: { id: businessUnit.id },
      include: {
        company: { select: { id: true, name: true } },
        _count: { select: { departments: true, users: true, projects: true, activities: true } },
      },
    });
    return NextResponse.json(withRelations, { status: 201 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/admin/business-units] POST failed", error);
    return internalErrorResponse();
  }
}
