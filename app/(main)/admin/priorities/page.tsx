import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { isAdmin, requireAnyDepartmentPermission, hasDepartmentPermission } from "@/lib/permissions";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { listDepartments } from "@/lib/services/department-service";
import { buildPriorityWhere } from "@/lib/services/department-scope-service";
import { NoWorkspaceState, ChooseWorkspaceState } from "@/components/workspace/workspace-gate";
import { WorkspaceConfigManager } from "@/components/admin/workspace-config-manager";

const PRIORITY_PERMISSION_KEYS = ["priority.create", "priority.edit", "priority.delete"];

const PRIORITY_FIELDS = [
  { key: "name", label: "Name", type: "text" as const, required: true },
  { key: "level", label: "Level (1 = lowest)", type: "number" as const, required: true },
  { key: "color", label: "Color", type: "color" as const, required: true },
];
const PRIORITY_EXTRA_COLUMNS = [
  { type: "field" as const, header: "Level", field: "level" },
  { type: "field" as const, header: "Tickets", field: "_count.tickets" },
];

export default async function PrioritiesAdminPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
  const userIsAdmin = isAdmin(session.user.role);

  if (activeWorkspace.isAllSelected) {
    if (!userIsAdmin) redirect("/dashboard");
    const departments = (await listDepartments()).map((d) => ({ id: d.id, name: d.name }));
    const priorities = await prisma.ticketPriority.findMany({
      orderBy: { level: "desc" },
      include: { _count: { select: { tickets: true } }, department: { select: { id: true, name: true } } },
    });
    return (
      <PageShell>
        <WorkspaceConfigManager
          entityLabel="Priority"
          entityLabelPlural="Priorities"
          apiEndpoint="/api/admin/priorities"
          items={priorities as any}
          fields={PRIORITY_FIELDS}
          extraColumns={PRIORITY_EXTRA_COLUMNS}
          departmentOptions={departments}
          mode="all"
          canCreateGlobal={false}
          deleteSemantics="hard-when-unused"
          canCreate={true}
          canEdit={true}
          canDelete={true}
        />
      </PageShell>
    );
  }

  const departmentId = activeWorkspace.departmentId;
  if (!departmentId) {
    return activeWorkspace.departments.length === 0 ? <NoWorkspaceState /> : <ChooseWorkspaceState departments={activeWorkspace.departments} />;
  }

  let access;
  try {
    access = await requireAnyDepartmentPermission(departmentId, PRIORITY_PERMISSION_KEYS);
  } catch {
    redirect("/dashboard");
  }

  const priorities = await prisma.ticketPriority.findMany({
    where: buildPriorityWhere(departmentId),
    orderBy: { level: "desc" },
    include: { _count: { select: { tickets: true } }, department: { select: { id: true, name: true } } },
  });
  const departmentOptions = userIsAdmin ? (await listDepartments()).map((d) => ({ id: d.id, name: d.name })) : [];
  const [canCreate, canEdit, canDelete] = await Promise.all([
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "priority.create", access.membership!.customRoleId),
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "priority.edit", access.membership!.customRoleId),
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "priority.delete", access.membership!.customRoleId),
  ]);

  return (
    <PageShell>
      <WorkspaceConfigManager
        entityLabel="Priority"
        entityLabelPlural="Priorities"
        apiEndpoint="/api/admin/priorities"
        items={priorities as any}
        fields={PRIORITY_FIELDS}
        extraColumns={PRIORITY_EXTRA_COLUMNS}
        departmentOptions={departmentOptions}
        fixedDepartmentId={userIsAdmin ? undefined : departmentId}
        initialViewDepartmentId={departmentId}
        mode="scoped"
        canCreateGlobal={false}
        deleteSemantics="hard-when-unused"
        canCreate={canCreate}
        canEdit={canEdit}
        canDelete={canDelete}
      />
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Priorities</h1>
        <p className="text-muted-foreground mt-1">
          Manage ticket priority levels for the current workspace — switch workspace in the top nav to manage another department.
        </p>
      </div>
      {children}
    </div>
  );
}
