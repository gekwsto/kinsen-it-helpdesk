import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireAnyDepartmentPermission, hasDepartmentPermission } from "@/lib/permissions";
import { getDepartmentProgressRows } from "@/lib/activities/activity-progress";
import { getDepartmentActivityStatusRows } from "@/lib/services/activity-status-config";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { ActivityProgressConfigForm } from "@/components/admin/activity-progress-config-form";

const ACTIVITY_PROGRESS_PERMISSION_KEYS = ["activityProgress.create", "activityProgress.edit", "activityProgress.delete"];

export default async function DepartmentActivityProgressPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  let access;
  try {
    access = await requireAnyDepartmentPermission(id, ACTIVITY_PROGRESS_PERMISSION_KEYS);
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
  const rows = await getDepartmentProgressRows(id);
  const statusDisplayRows = await getDepartmentActivityStatusRows(id);

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
        <span className="text-foreground font-medium">Activity Progress</span>
      </div>

      <div>
        <h1 className="text-2xl font-bold">{department.name} — Activity Progress</h1>
        <p className="text-muted-foreground mt-1">
          Progress percentage each activity status maps to, for this department&apos;s own activities.
        </p>
      </div>

      <ActivityProgressConfigForm departmentId={department.id} initialRows={rows} statusDisplayRows={statusDisplayRows} canCreate={canCreate} canEdit={canEdit} canDelete={canDelete} />
    </div>
  );
}
