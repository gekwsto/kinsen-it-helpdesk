import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { isAdmin, requireAnyDepartmentPermission, hasDepartmentPermission } from "@/lib/permissions";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { listDepartments } from "@/lib/services/department-service";
import { getDepartmentProgressRows } from "@/lib/activities/activity-progress";
import { getDepartmentActivityStatusRows } from "@/lib/services/activity-status-config";
import { NoWorkspaceState, ChooseWorkspaceState } from "@/components/workspace/workspace-gate";
import { ActivityProgressConfigForm } from "@/components/admin/activity-progress-config-form";

const ACTIVITY_PROGRESS_PERMISSION_KEYS = ["activityProgress.create", "activityProgress.edit", "activityProgress.delete"];

export default async function ActivityProgressAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ departmentId?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const params = await searchParams;

  const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
  const userIsAdmin = isAdmin(session.user.role);

  if (activeWorkspace.isAllSelected) {
    if (!userIsAdmin) redirect("/dashboard");
    const departments = (await listDepartments()).map((d) => ({ id: d.id, name: d.name }));
    const selectedDepartmentId = params.departmentId ?? departments[0]?.id;
    const rows = selectedDepartmentId ? await getDepartmentProgressRows(selectedDepartmentId) : null;
    const statusDisplayRows = selectedDepartmentId ? await getDepartmentActivityStatusRows(selectedDepartmentId) : [];

    return (
      <PageShell>
        {selectedDepartmentId && rows && (
          <ActivityProgressConfigForm
            departmentId={selectedDepartmentId}
            initialRows={rows}
            statusDisplayRows={statusDisplayRows}
            canCreate
            canEdit
            canDelete
            departmentOptions={departments}
          />
        )}
      </PageShell>
    );
  }

  const departmentId = activeWorkspace.departmentId;
  if (!departmentId) {
    return activeWorkspace.departments.length === 0 ? <NoWorkspaceState /> : <ChooseWorkspaceState departments={activeWorkspace.departments} />;
  }

  let access;
  try {
    access = await requireAnyDepartmentPermission(departmentId, ACTIVITY_PROGRESS_PERMISSION_KEYS);
  } catch {
    redirect("/dashboard");
  }

  const [canCreate, canEdit, canDelete] = access.isSystemAdmin
    ? [true, true, true]
    : await Promise.all([
        hasDepartmentPermission(access.membership!.role, "activityProgress.create", access.membership!.customRoleId),
        hasDepartmentPermission(access.membership!.role, "activityProgress.edit", access.membership!.customRoleId),
        hasDepartmentPermission(access.membership!.role, "activityProgress.delete", access.membership!.customRoleId),
      ]);
  const rows = await getDepartmentProgressRows(departmentId);
  const statusDisplayRows = await getDepartmentActivityStatusRows(departmentId);

  return (
    <PageShell>
      <ActivityProgressConfigForm departmentId={departmentId} initialRows={rows} statusDisplayRows={statusDisplayRows} canCreate={canCreate} canEdit={canEdit} canDelete={canDelete} />
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Activity Progress</h1>
        <p className="text-muted-foreground mt-1">
          Set the progress percentage each activity status maps to for the current workspace — switch workspace in the top nav to manage another department.
        </p>
      </div>
      {children}
    </div>
  );
}
