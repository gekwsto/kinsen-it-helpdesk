import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { isAdmin, requireAnyDepartmentPermission, hasDepartmentPermission } from "@/lib/permissions";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { listDepartments } from "@/lib/services/department-service";
import { buildStatusWhere } from "@/lib/services/department-scope-service";
import { NoWorkspaceState, ChooseWorkspaceState } from "@/components/workspace/workspace-gate";
import { WorkspaceConfigManager } from "@/components/admin/workspace-config-manager";

const STATUS_PERMISSION_KEYS = ["status.create", "status.edit", "status.delete"];

const STATUS_FIELDS = [
  { key: "name", label: "Name", type: "text" as const, required: true },
  { key: "color", label: "Color", type: "color" as const, required: true },
  { key: "order", label: "Display Order", type: "number" as const },
  { key: "isDefault", label: "Default status for new tickets", type: "checkbox" as const },
  { key: "isClosed", label: "Counts as a closed/resolved state", type: "checkbox" as const },
];
const STATUS_EXTRA_COLUMNS = [
  {
    type: "badges" as const,
    header: "Type",
    badges: [
      { field: "isDefault", label: "Default", className: "bg-blue-100 text-blue-700" },
      { field: "isClosed", label: "Closed", className: "bg-gray-100 text-gray-700" },
    ],
  },
  { type: "field" as const, header: "Tickets", field: "_count.tickets" },
];

export default async function StatusesAdminPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
  const userIsAdmin = isAdmin(session.user.role);

  if (activeWorkspace.isAllSelected) {
    if (!userIsAdmin) redirect("/dashboard");
    const departments = (await listDepartments()).map((d) => ({ id: d.id, name: d.name }));
    const statuses = await prisma.ticketStatus.findMany({
      orderBy: { order: "asc" },
      include: { _count: { select: { tickets: true } }, department: { select: { id: true, name: true } } },
    });
    return (
      <PageShell>
        <WorkspaceConfigManager
          entityLabel="Status"
          entityLabelPlural="Statuses"
          apiEndpoint="/api/admin/statuses"
          items={statuses as any}
          fields={STATUS_FIELDS}
          extraColumns={STATUS_EXTRA_COLUMNS}
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
    access = await requireAnyDepartmentPermission(departmentId, STATUS_PERMISSION_KEYS);
  } catch {
    redirect("/dashboard");
  }

  const statuses = await prisma.ticketStatus.findMany({
    where: buildStatusWhere(departmentId),
    orderBy: { order: "asc" },
    include: { _count: { select: { tickets: true } }, department: { select: { id: true, name: true } } },
  });
  const departmentOptions = userIsAdmin ? (await listDepartments()).map((d) => ({ id: d.id, name: d.name })) : [];
  const [canCreate, canEdit, canDelete] = await Promise.all([
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "status.create", access.membership!.customRoleId),
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "status.edit", access.membership!.customRoleId),
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "status.delete", access.membership!.customRoleId),
  ]);

  return (
    <PageShell>
      <WorkspaceConfigManager
        entityLabel="Status"
        entityLabelPlural="Statuses"
        apiEndpoint="/api/admin/statuses"
        items={statuses as any}
        fields={STATUS_FIELDS}
        extraColumns={STATUS_EXTRA_COLUMNS}
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
        <h1 className="text-2xl font-bold">Ticket Statuses</h1>
        <p className="text-muted-foreground mt-1">
          Manage the ticket workflow statuses for the current workspace — switch workspace in the top nav to manage another department.
        </p>
      </div>
      {children}
    </div>
  );
}
