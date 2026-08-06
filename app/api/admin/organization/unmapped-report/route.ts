import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import { canViewFullOrganizationTree } from "@/lib/services/organization-scope-service";
import { getDepartmentTree } from "@/lib/services/organization-tree-service";
import { buildManagerMappingReport } from "@/lib/services/organization-unmapped-report-service";
import { unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

const MAX_LISTED = 200;

function flattenDepartmentNodes(nodes: Awaited<ReturnType<typeof getDepartmentTree>>): Awaited<ReturnType<typeof getDepartmentTree>> {
  const flat: Awaited<ReturnType<typeof getDepartmentTree>> = [];
  for (const node of nodes) {
    flat.push(node, ...flattenDepartmentNodes(node.children));
  }
  return flat;
}

// GET /api/admin/organization/unmapped-report — active users without a
// department, a full manager-mapping status breakdown (SYNCED/
// EXPECTED_ROOT/MANAGER_NOT_ASSIGNED/MANAGER_NOT_SYNCED/MANAGER_INACTIVE/
// INVALID_SELF_MANAGER/MANAGER_CYCLE — see organization-unmapped-report-service.ts;
// a legitimate root with real direct reports is never reported as a
// problem), and departments/subdepartments with zero active users. Same
// audience as the visualization page (full-tree access), not
// sync-trigger-only.
export async function GET() {
  try {
    const session = await requireAuth();
    const allowed = await canViewFullOrganizationTree(session.user.role, session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You do not have permission to view the organization unmapped report.");

    const [usersWithoutDepartment, usersWithoutDepartmentCount, managerMapping, fullTree] = await Promise.all([
      prisma.user.findMany({
        where: { isActive: true, departmentId: null },
        select: { id: true, name: true, email: true },
        take: MAX_LISTED,
        orderBy: { name: "asc" },
      }),
      prisma.user.count({ where: { isActive: true, departmentId: null } }),
      buildManagerMappingReport(MAX_LISTED),
      getDepartmentTree({ activeOnly: false }),
    ]);

    const departmentsWithNoActiveUsers = flattenDepartmentNodes(fullTree)
      .filter((n) => (n.type === "department" || n.type === "subDepartment") && n.activeUserCount === 0)
      .slice(0, MAX_LISTED)
      .map((n) => ({ id: n.id, name: n.name, type: n.type, isActive: n.isActive }));

    return NextResponse.json({
      usersWithoutDepartment: { items: usersWithoutDepartment, totalCount: usersWithoutDepartmentCount },
      managerMapping,
      departmentsWithNoActiveUsers,
    });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/admin/organization/unmapped-report] failed", error);
    return internalErrorResponse();
  }
}
