import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canViewAllDepartments } from "@/lib/permissions";
import { getAccessibleDepartmentSummaries } from "@/lib/services/department-scope-service";
import { redirect } from "next/navigation";
import { SubDepartmentManagement } from "@/components/admin/sub-department-management";
import { SubDepartmentAdminFilters } from "@/components/admin/sub-department-admin-filters";

interface SearchParams {
  departmentId?: string;
  search?: string;
}

/**
 * Cross-department admin view — unlike the nested
 * /admin/departments/[id]/sub-departments page (one department at a time),
 * this lists every sub-department the caller can administer across every
 * department they have subdepartment.view in (all departments for
 * ADMIN/DIRECTOR-tier). Mutations still go through the existing nested
 * /api/admin/departments/[id]/sub-departments(...) routes — this page only
 * adds a new read path.
 */
export default async function AdminSubDepartmentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { role, id: userId, customRoleId } = session.user;

  const [viewableDepartments, createDepartments, updateDepartments, deleteDepartments] = await Promise.all([
    getAccessibleDepartmentSummaries(userId, role, "subdepartment.view"),
    getAccessibleDepartmentSummaries(userId, role, "subdepartment.create"),
    getAccessibleDepartmentSummaries(userId, role, "subdepartment.update"),
    getAccessibleDepartmentSummaries(userId, role, "subdepartment.delete"),
  ]);

  if (viewableDepartments.length === 0) redirect("/dashboard");

  const viewableDepartmentIds = viewableDepartments.map((d) => d.id);
  const params = await searchParams;
  const selectedDepartmentId = params.departmentId && viewableDepartmentIds.includes(params.departmentId) ? params.departmentId : undefined;

  const where = {
    departmentId: { in: selectedDepartmentId ? [selectedDepartmentId] : viewableDepartmentIds },
    ...(params.search ? { name: { contains: params.search, mode: "insensitive" as const } } : {}),
  };

  const subDepartments = await prisma.subDepartment.findMany({
    where,
    orderBy: [{ department: { name: "asc" } }, { name: "asc" }],
    include: {
      department: { select: { id: true, name: true } },
      _count: {
        select: {
          memberships: { where: { isActive: true } },
          tickets: true,
          projects: true,
          activities: true,
        },
      },
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Sub Departments</h1>
        <p className="text-muted-foreground mt-1">
          {canViewAllDepartments(role)
            ? "Every sub-department across every department."
            : "Sub-departments in the departments you administer."}
        </p>
      </div>

      <SubDepartmentAdminFilters departments={viewableDepartments} />

      <SubDepartmentManagement
        subDepartments={subDepartments as any}
        showCounts
        departments={viewableDepartments}
        createDepartmentIds={createDepartments.map((d) => d.id)}
        updateDepartmentIds={updateDepartments.map((d) => d.id)}
        deleteDepartmentIds={deleteDepartments.map((d) => d.id)}
      />
    </div>
  );
}
