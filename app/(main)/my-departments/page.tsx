import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canViewAllDepartments, hasAnyDepartmentPermission, hasDepartmentPermission } from "@/lib/permissions";
import { getUserDepartmentMemberships } from "@/lib/services/department-membership-service";
import { listDepartments } from "@/lib/services/department-service";
import { DEPARTMENT_ROLE_LABELS } from "@/lib/services/department-role-translation";
import { redirect } from "next/navigation";
import { MyDepartmentsView, type MyDepartmentRow } from "@/components/organization/my-departments-view";

/**
 * Operational counterpart to /admin/departments: scoped to what the current
 * user actually belongs to or manages, reachable without global Administrator
 * — a Department Manager sees and can act on their own department here, the
 * same way the admin page lets a System Admin see and act on every one.
 */
export default async function MyDepartmentsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { id: userId, role } = session.user;
  const isCrossDepartment = canViewAllDepartments(role);

  const departmentIds = isCrossDepartment
    ? (await listDepartments()).map((d) => d.id)
    : (await getUserDepartmentMemberships(userId)).map((m) => m.departmentId);

  if (departmentIds.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">My Departments</h1>
          <p className="text-muted-foreground mt-1">Departments you belong to or manage.</p>
        </div>
        <MyDepartmentsView departments={[]} />
      </div>
    );
  }

  const [departments, memberships] = await Promise.all([
    prisma.department.findMany({
      where: { id: { in: departmentIds } },
      orderBy: { name: "asc" },
      include: {
        _count: { select: { memberships: true, tickets: true, projects: true, activities: true, subDepartments: true } },
      },
    }),
    isCrossDepartment ? Promise.resolve([]) : getUserDepartmentMemberships(userId),
  ]);

  const membershipByDeptId = new Map(memberships.map((m) => [m.departmentId, m]));
  const customRoleIds = memberships.map((m) => m.customRoleId).filter((id): id is string => !!id);
  const customRoles = customRoleIds.length
    ? await prisma.customRole.findMany({ where: { id: { in: customRoleIds } }, select: { id: true, name: true } })
    : [];
  const customRoleNameById = new Map(customRoles.map((r) => [r.id, r.name]));

  const rows: MyDepartmentRow[] = await Promise.all(
    departments.map(async (dept) => {
      const membership = membershipByDeptId.get(dept.id);
      const roleLabel = isCrossDepartment
        ? role === "ADMIN"
          ? "System Administrator — full access"
          : "Director — cross-department view"
        : membership?.customRoleId
        ? (customRoleNameById.get(membership.customRoleId) ?? "Custom role")
        : membership
        ? DEPARTMENT_ROLE_LABELS[membership.role]
        : "—";

      const canManageMembers = isCrossDepartment
        ? true
        : membership
        ? await hasAnyDepartmentPermission(
            membership.role,
            ["department.manageMembers", "department.user.assign", "department.user.unassign"],
            membership.customRoleId
          )
        : false;
      const canCreateSubDepartment = isCrossDepartment
        ? true
        : membership
        ? await hasDepartmentPermission(membership.role, "subdepartment.create", membership.customRoleId)
        : false;
      const canViewSubDepartments = isCrossDepartment
        ? true
        : membership
        ? await hasDepartmentPermission(membership.role, "subdepartment.view", membership.customRoleId)
        : false;

      return {
        id: dept.id,
        name: dept.name,
        isActive: dept.isActive,
        roleLabel,
        counts: {
          members: dept._count.memberships,
          tickets: dept._count.tickets,
          projects: dept._count.projects,
          activities: dept._count.activities,
          subDepartments: dept._count.subDepartments,
        },
        canManageMembers,
        canCreateSubDepartment,
        canViewSubDepartments,
      };
    })
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">My Departments</h1>
        <p className="text-muted-foreground mt-1">
          {isCrossDepartment ? "Every department (cross-department access)." : "Departments you belong to."}
        </p>
      </div>
      <MyDepartmentsView departments={rows} />
    </div>
  );
}
