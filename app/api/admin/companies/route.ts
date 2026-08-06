import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { createCompanySchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

// GET /api/admin/companies — Administrator (or a custom role granted
// company.create/update/delete) only; the top level of the organization
// hierarchy (Company -> BusinessUnit -> Department -> SubDepartment), same
// pattern as /api/admin/departments.
export async function GET() {
  try {
    const session = await requireAuth();
    const allowed =
      (await hasPermission(session.user.role, "company.create", session.user.customRoleId)) ||
      (await hasPermission(session.user.role, "company.update", session.user.customRoleId)) ||
      (await hasPermission(session.user.role, "company.delete", session.user.customRoleId));
    if (!allowed) return forbiddenResponse("You do not have permission to view companies.");

    const companies = await prisma.company.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { businessUnits: true, users: true } } },
    });
    return NextResponse.json(companies);
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/admin/companies] GET failed", error);
    return internalErrorResponse();
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "company.create", session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You do not have permission to create companies.");

    const body = await req.json();
    const parsed = createCompanySchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    const existing = await prisma.company.findUnique({ where: { domain: parsed.data.domain }, select: { id: true } });
    if (existing) {
      return NextResponse.json(apiError("domain_taken", "A company with this domain already exists.", { field: "domain" }), { status: 409 });
    }

    const company = await prisma.company.create({ data: parsed.data });
    const withCounts = await prisma.company.findUnique({
      where: { id: company.id },
      include: { _count: { select: { businessUnits: true, users: true } } },
    });
    return NextResponse.json(withCounts, { status: 201 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/admin/companies] POST failed", error);
    return internalErrorResponse();
  }
}
