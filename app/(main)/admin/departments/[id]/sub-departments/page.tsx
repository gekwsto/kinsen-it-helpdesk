import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireDepartmentPermission, hasDepartmentPermission } from "@/lib/permissions";
import { listSubDepartments } from "@/lib/services/sub-department-service";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { SubDepartmentManagement } from "@/components/admin/sub-department-management";

export default async function SubDepartmentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  let access;
  try {
    access = await requireDepartmentPermission(id, "subdepartment.view");
  } catch {
    redirect("/dashboard");
  }

  const department = await prisma.department.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!department) notFound();

  const [subDepartments, canCreate, canUpdate, canDelete] = await Promise.all([
    listSubDepartments(id, { includeInactive: true }),
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "subdepartment.create", access.membership!.customRoleId),
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "subdepartment.update", access.membership!.customRoleId),
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "subdepartment.delete", access.membership!.customRoleId),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/admin/departments" className="hover:text-foreground transition-colors">
          Departments
        </Link>
        <ChevronRight className="h-4 w-4" />
        <Link href={`/admin/departments/${department.id}`} className="hover:text-foreground transition-colors">
          {department.name}
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground font-medium">Sub-Departments</span>
      </div>

      <div>
        <h1 className="text-2xl font-bold">{department.name} — Sub-Departments</h1>
        <p className="text-muted-foreground mt-1">
          Finer-grained grouping inside this department, for filtering tickets, projects and activities.
        </p>
      </div>

      <SubDepartmentManagement
        departmentId={department.id}
        subDepartments={subDepartments}
        canCreate={canCreate}
        canUpdate={canUpdate}
        canDelete={canDelete}
      />
    </div>
  );
}
