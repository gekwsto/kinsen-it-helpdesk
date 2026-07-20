import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireAnyDepartmentPermission, hasAnyDepartmentPermission, hasDepartmentPermission } from "@/lib/permissions";
import { getDepartmentMemberships } from "@/lib/services/department-membership-service";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { DepartmentMembersManagement } from "@/components/admin/department-members-management";

const MEMBER_PAGE_VIEW_PERMISSIONS = ["department.manageMembers", "department.user.assign", "department.user.unassign"];

export default async function DepartmentMembersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  let access;
  try {
    // Reachable by anyone with ANY of the three member-management
    // permissions — a Department Manager with only assign/unassign (not the
    // older manageMembers) must still reach this page; the component itself
    // narrows which controls actually render (see canAssign/canUnassign/
    // canChangeRole below).
    access = await requireAnyDepartmentPermission(id, MEMBER_PAGE_VIEW_PERMISSIONS);
  } catch {
    redirect("/dashboard");
  }

  const department = await prisma.department.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!department) notFound();

  const role = access.membership?.role;
  const customRoleId = access.membership?.customRoleId;

  const [memberships, canAssign, canUnassign, canChangeRole] = await Promise.all([
    getDepartmentMemberships(id),
    access.isSystemAdmin || hasAnyDepartmentPermission(role!, ["department.manageMembers", "department.user.assign"], customRoleId),
    access.isSystemAdmin || hasAnyDepartmentPermission(role!, ["department.manageMembers", "department.user.unassign"], customRoleId),
    access.isSystemAdmin || hasDepartmentPermission(role!, "department.manageMembers", customRoleId),
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
        canAssign={canAssign}
        canUnassign={canUnassign}
        canChangeRole={canChangeRole}
      />
    </div>
  );
}
