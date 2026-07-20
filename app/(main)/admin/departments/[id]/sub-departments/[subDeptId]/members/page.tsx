import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireDepartmentPermission } from "@/lib/permissions";
import { getSubDepartmentMemberships } from "@/lib/services/sub-department-membership-service";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { SubDepartmentMembersManagement } from "@/components/admin/sub-department-members-management";

export default async function SubDepartmentMembersPage({
  params,
}: {
  params: Promise<{ id: string; subDeptId: string }>;
}) {
  const { id, subDeptId } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  try {
    await requireDepartmentPermission(id, "subdepartment.view");
  } catch {
    redirect("/dashboard");
  }

  const [department, subDepartment] = await Promise.all([
    prisma.department.findUnique({ where: { id }, select: { id: true, name: true } }),
    prisma.subDepartment.findUnique({ where: { id: subDeptId }, select: { id: true, name: true, departmentId: true } }),
  ]);
  if (!department || !subDepartment || subDepartment.departmentId !== id) notFound();

  const memberships = await getSubDepartmentMemberships(subDeptId);

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
        <Link href={`/admin/departments/${department.id}/sub-departments`} className="hover:text-foreground transition-colors">
          Sub-Departments
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground font-medium">{subDepartment.name}</span>
      </div>

      <div>
        <h1 className="text-2xl font-bold">{subDepartment.name} — Members</h1>
        <p className="text-muted-foreground mt-1">
          Only active members of {department.name} can be assigned here.
        </p>
      </div>

      <SubDepartmentMembersManagement
        departmentId={department.id}
        subDepartmentId={subDepartment.id}
        subDepartmentName={subDepartment.name}
        memberships={memberships}
      />
    </div>
  );
}
