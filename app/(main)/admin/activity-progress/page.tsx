import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { isAdmin, requireAnyDepartmentPermission, hasDepartmentPermission } from "@/lib/permissions";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { listDepartments } from "@/lib/services/department-service";
import { getDepartmentProgressConfig } from "@/lib/activities/activity-progress";
import { NoWorkspaceState, ChooseWorkspaceState } from "@/components/workspace/workspace-gate";
import { ActivityProgressConfigForm } from "@/components/admin/activity-progress-config-form";
import { ActivityProgressDepartmentPicker } from "@/components/admin/activity-progress-department-picker";

const ACTIVITY_PROGRESS_PERMISSION_KEYS = ["activityProgress.edit"];

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
    const config = selectedDepartmentId ? await getDepartmentProgressConfig(selectedDepartmentId) : null;

    return (
      <PageShell>
        <ActivityProgressDepartmentPicker departments={departments} selectedDepartmentId={selectedDepartmentId} />
        {selectedDepartmentId && config && (
          <ActivityProgressConfigForm departmentId={selectedDepartmentId} initialConfig={config} canEdit={true} />
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

  const canEdit = access.isSystemAdmin || (await hasDepartmentPermission(access.membership!.role, "activityProgress.edit", access.membership!.customRoleId));
  const config = await getDepartmentProgressConfig(departmentId);

  return (
    <PageShell>
      <ActivityProgressConfigForm departmentId={departmentId} initialConfig={config} canEdit={canEdit} />
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
