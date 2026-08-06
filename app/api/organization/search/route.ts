import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { requireAuth } from "@/lib/permissions";
import { canViewFullOrganizationTree } from "@/lib/services/organization-scope-service";
import { unauthorizedResponse, internalErrorResponse } from "@/lib/api-errors";

const MAX_RESULTS = 25;

export interface OrganizationSearchResult {
  type: "user" | "department";
  id: string;
  label: string;
  sublabel: string | null;
}

// GET /api/organization/search?q=... — department name, person name, email,
// or job title. Scoped the SAME way as the tree endpoints: full access
// searches the whole org; every other authenticated user searches only
// within their own department + own manager chain + own direct reports
// (never an arbitrary cross-department name lookup without permission).
export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth();
    const q = req.nextUrl.searchParams.get("q")?.trim();
    if (!q || q.length < 2) return NextResponse.json({ results: [] });

    const fullAccess = await canViewFullOrganizationTree(session.user.role, session.user.customRoleId);

    const textMatch = {
      OR: [
        { name: { contains: q, mode: "insensitive" as const } },
        { email: { contains: q, mode: "insensitive" as const } },
        { jobTitle: { contains: q, mode: "insensitive" as const } },
      ],
    };

    let userWhere: Prisma.UserWhereInput;
    if (fullAccess) {
      userWhere = textMatch;
    } else {
      const self = await prisma.user.findUnique({ where: { id: session.user.id }, select: { managerId: true } });
      const visibleIds = [session.user.id, ...(self?.managerId ? [self.managerId] : [])];
      userWhere = {
        AND: [{ OR: [{ id: { in: visibleIds } }, { managerId: session.user.id }] }, textMatch],
      };
    }

    const users = await prisma.user.findMany({
      where: userWhere,
      select: { id: true, name: true, email: true, jobTitle: true },
      take: MAX_RESULTS,
      orderBy: { name: "asc" },
    });

    const results: OrganizationSearchResult[] = users.map((u) => ({
      type: "user",
      id: u.id,
      label: u.name ?? u.email,
      sublabel: u.jobTitle,
    }));

    if (fullAccess) {
      const departments = await prisma.department.findMany({
        where: { name: { contains: q, mode: "insensitive" } },
        select: { id: true, name: true, isActive: true },
        take: MAX_RESULTS,
        orderBy: { name: "asc" },
      });
      results.push(
        ...departments.map((d) => ({
          type: "department" as const,
          id: d.id,
          label: d.name,
          sublabel: d.isActive ? null : "Inactive",
        }))
      );
    }

    return NextResponse.json({ results: results.slice(0, MAX_RESULTS) });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/organization/search] failed", error);
    return internalErrorResponse();
  }
}
