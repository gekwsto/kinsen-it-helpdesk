import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canViewAllDepartments } from "@/lib/permissions";
import { getUserSubDepartmentIds } from "@/lib/services/sub-department-membership-service";
import { getAccessibleDepartmentSummaries } from "@/lib/services/department-scope-service";
import { redirect } from "next/navigation";
import { SubDepartmentManagement } from "@/components/admin/sub-department-management";

/**
 * Operational counterpart to /admin/sub-departments: shows sub-departments
 * the user personally belongs to (active SubDepartmentMembership) UNION
 * sub-departments in departments they can view/manage sub-departments in —
 * not admin-only, reachable by a Department Manager for their own
 * department. Mutations reuse the same nested API routes as the admin page.
 */
export default async function MySubDepartmentsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { id: userId, role } = session.user;
  const isCrossDepartment = canViewAllDepartments(role);

  const [viewableDepartments, createDepartments, updateDepartments, deleteDepartments] = await Promise.all([
    getAccessibleDepartmentSummaries(userId, role, "subdepartment.view"),
    getAccessibleDepartmentSummaries(userId, role, "subdepartment.create"),
    getAccessibleDepartmentSummaries(userId, role, "subdepartment.update"),
    getAccessibleDepartmentSummaries(userId, role, "subdepartment.delete"),
  ]);

  const viewableDepartmentIds = viewableDepartments.map((d) => d.id);
  const membershipSubDeptIds = isCrossDepartment ? [] : await getUserSubDepartmentIds(userId);

  if (!isCrossDepartment && viewableDepartmentIds.length === 0 && membershipSubDeptIds.length === 0) {
    redirect("/dashboard");
  }

  const where = isCrossDepartment
    ? {}
    : {
        OR: [
          { departmentId: { in: viewableDepartmentIds } },
          { id: { in: membershipSubDeptIds } },
        ],
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

  const pickerDepartments = isCrossDepartment
    ? Array.from(new Map(subDepartments.map((sd) => [sd.department.id, sd.department])).values())
    : viewableDepartments;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">My SubDepartments</h1>
        <p className="text-muted-foreground mt-1">
          {isCrossDepartment ? "Every sub-department (cross-department access)." : "Sub-departments you belong to or manage."}
        </p>
      </div>

      <SubDepartmentManagement
        subDepartments={subDepartments as any}
        showCounts
        departments={pickerDepartments}
        createDepartmentIds={isCrossDepartment ? pickerDepartments.map((d) => d.id) : createDepartments.map((d) => d.id)}
        updateDepartmentIds={isCrossDepartment ? pickerDepartments.map((d) => d.id) : updateDepartments.map((d) => d.id)}
        deleteDepartmentIds={isCrossDepartment ? pickerDepartments.map((d) => d.id) : deleteDepartments.map((d) => d.id)}
      />
    </div>
  );
}
