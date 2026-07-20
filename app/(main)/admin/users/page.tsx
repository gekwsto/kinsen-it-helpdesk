import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { UserManagement } from "@/components/admin/user-management";

interface SearchParams {
  departmentId?: string;
}

export default async function UsersAdminPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  try {
    await requireAdmin();
  } catch {
    redirect("/dashboard");
  }

  const params = await searchParams;
  const selectedDepartmentId = params.departmentId && params.departmentId !== "all" ? params.departmentId : "all";

  // "All" (default) = every user, including legacy-null-department and
  // memberless ones. A specific department = active DepartmentMembership in
  // it OR the legacy User.departmentId field — matched via OR on the same
  // findMany call, so a user row is never duplicated (no fan-out join).
  const userWhere =
    selectedDepartmentId === "all"
      ? {}
      : {
          OR: [
            { departmentMemberships: { some: { departmentId: selectedDepartmentId, isActive: true } } },
            { departmentId: selectedDepartmentId },
          ],
        };

  const [users, departments, businessUnits] = await Promise.all([
    prisma.user.findMany({
      where: userWhere,
      orderBy: { name: "asc" },
      include: {
        department: { select: { id: true, name: true } },
        businessUnit: { select: { id: true, name: true } },
        customRole: { select: { id: true, key: true, name: true } },
        departmentMemberships: {
          include: { department: { select: { id: true, name: true, slug: true } } },
          orderBy: { createdAt: "asc" },
        },
        globalRoleMicrosoftMapping: {
          select: { microsoftValue: true, department: { select: { name: true } } },
        },
      },
    }),
    prisma.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.businessUnit.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">User Management</h1>
        <p className="text-muted-foreground mt-1">
          Manage user roles and permissions
        </p>
      </div>
      <UserManagement
        users={users as any}
        departments={departments}
        businessUnits={businessUnits}
        currentUserId={session.user.id}
        selectedDepartmentId={selectedDepartmentId}
      />
    </div>
  );
}
