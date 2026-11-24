import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import { unauthorizedResponse, internalErrorResponse } from "@/lib/api-errors";

/**
 * Plain, lightweight "pick a Department" list — any authenticated user, no
 * special permission required (merely appearing in this picker list grants
 * nothing; actual selection is independently re-validated server-side
 * wherever it's submitted — see resolveProjectAudienceOrganizationalIds).
 * Active departments only, matching the one existing precedent for this
 * exact kind of picker (GET /api/users for Owner(s)/Audience — "any active
 * user in the system").
 *
 * Added for the Project Audience "Departments" selection group
 * (components/projects/project-form.tsx / the standalone edit page) — the
 * app previously had no plain, non-admin-gated department list endpoint at
 * all (only /api/admin/departments, which requires department management
 * permission, and /api/departments/[id]/* sub-resources scoped to one
 * already-known department).
 */
export async function GET() {
  try {
    await requireAuth();
    const departments = await prisma.department.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    return NextResponse.json(departments);
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    return internalErrorResponse();
  }
}
