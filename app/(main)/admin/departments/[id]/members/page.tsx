import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireDepartmentPermission } from "@/lib/permissions";
import { getDepartmentMemberships } from "@/lib/services/department-membership-service";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { DepartmentMembersManagement } from "@/components/admin/department-members-management";

export default async function DepartmentMembersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  try {
    await requireDepartmentPermission(id, "department.manageMembers");
  } catch {
    redirect("/dashboard");
  }

  const department = await prisma.department.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!department) notFound();

  const memberships = await getDepartmentMemberships(id);

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
        <span className="text-foreground font-medium">Members</span>
      </div>

      <div>
        <h1 className="text-2xl font-bold">{department.name} — Members</h1>
        <p className="text-muted-foreground mt-1">Assign users, change roles, and revoke access.</p>
      </div>

      <DepartmentMembersManagement
        departmentId={department.id}
        departmentName={department.name}
        memberships={memberships as any}
      />
    </div>
  );
}
