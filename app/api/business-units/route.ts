import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import { unauthorizedResponse, internalErrorResponse } from "@/lib/api-errors";

/**
 * Plain, lightweight "pick a Business Unit" list — any authenticated user,
 * no special permission required. Same rationale as GET /api/departments
 * (added alongside it for the Project Audience "Business Units" selection
 * group) — distinct from GET /api/admin/business-units, which requires
 * businessUnit.create/update/delete and returns admin-only detail
 * (company, counts) no picker needs. BusinessUnit has no isActive column
 * at all (confirmed in prisma/schema.prisma), so every row is listed.
 */
export async function GET() {
  try {
    await requireAuth();
    const businessUnits = await prisma.businessUnit.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    return NextResponse.json(businessUnits);
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    return internalErrorResponse();
  }
}
