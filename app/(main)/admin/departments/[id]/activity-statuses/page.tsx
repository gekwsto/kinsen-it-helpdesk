import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireAnyDepartmentPermission, hasDepartmentPermission } from "@/lib/permissions";
import { getDepartmentActivityStatusRows } from "@/lib/services/activity-status-config";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { ActivityStatusConfigForm } from "@/components/admin/activity-status-config-form";

const ACTIVITY_STATUS_PERMISSION_KEYS = ["activityProgress.create", "activityProgress.edit", "activityProgress.delete"];

export default async function DepartmentActivityStatusesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  let access;
  try {
    access = await requireAnyDepartmentPermission(id, ACTIVITY_STATUS_PERMISSION_KEYS);
  } catch {
    redirect("/dashboard");
  }

  const department = await prisma.department.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!department) notFound();

  const [canCreate, canEdit, canDelete] = access.isSystemAdmin
    ? [true, true, true]
    : await Promise.all([
        hasDepartmentPermission(access.membership!.role, "activityProgress.create", access.membership!.customRoleId),
        hasDepartmentPermission(access.membership!.role, "activityProgress.edit", access.membership!.customRoleId),
        hasDepartmentPermission(access.membership!.role, "activityProgress.delete", access.membership!.customRoleId),
      ]);
  const rows = await getDepartmentActivityStatusRows(id);

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
        <span className="text-foreground font-medium">Activity Statuses</span>
      </div>

      <div>
        <h1 className="text-2xl font-bold">{department.name} — Activity Statuses</h1>
        <p className="text-muted-foreground mt-1">
          Display label, color, order, enabled state, and terminal state for each activity status in this department.
        </p>
      </div>

      <ActivityStatusConfigForm departmentId={department.id} initialRows={rows} canCreate={canCreate} canEdit={canEdit} canDelete={canDelete} />
    </div>
  );
}
