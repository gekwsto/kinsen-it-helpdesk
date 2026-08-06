import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { updateCompanySchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "company.update", session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You do not have permission to edit companies.");

    const body = await req.json();
    const parsed = updateCompanySchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    if (parsed.data.domain) {
      const existing = await prisma.company.findFirst({ where: { domain: parsed.data.domain, NOT: { id } }, select: { id: true } });
      if (existing) {
        return NextResponse.json(apiError("domain_taken", "A company with this domain already exists.", { field: "domain" }), { status: 409 });
      }
    }

    const company = await prisma.company.update({
      where: { id },
      data: parsed.data,
      include: { _count: { select: { businessUnits: true, users: true } } },
    });
    return NextResponse.json(company);
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (error?.code === "P2025") return NextResponse.json(apiError("not_found", "Company not found."), { status: 404 });
    console.error("[api/admin/companies/[id]] PATCH failed", error);
    return internalErrorResponse();
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "company.delete", session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You do not have permission to delete companies.");

    const company = await prisma.company.findUnique({
      where: { id },
      include: { _count: { select: { businessUnits: true, users: true } } },
    });
    if (!company) return NextResponse.json(apiError("not_found", "Company not found."), { status: 404 });

    const counts = company._count;
    const totalDependents = counts.businessUnits + counts.users;
    if (totalDependents > 0) {
      const parts = Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([key, n]) => `${n} ${key}`)
        .join(", ");
      return NextResponse.json(
        apiError("has_dependents", `Cannot delete a company that still has ${parts}. Move or remove them first.`),
        { status: 409 }
      );
    }

    await prisma.company.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/admin/companies/[id]] DELETE failed", error);
    return internalErrorResponse();
  }
}
