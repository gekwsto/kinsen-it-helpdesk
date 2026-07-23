import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { isAdmin, requireAnyDepartmentPermission, hasDepartmentPermission } from "@/lib/permissions";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { listDepartments } from "@/lib/services/department-service";
import { buildCancelReasonWhere } from "@/lib/services/department-scope-service";
import { NoWorkspaceState, ChooseWorkspaceState } from "@/components/workspace/workspace-gate";
import { WorkspaceConfigManager } from "@/components/admin/workspace-config-manager";

const CANCEL_REASON_PERMISSION_KEYS = ["cancelReason.create", "cancelReason.edit", "cancelReason.delete"];

const CANCEL_REASON_FIELDS = [
  { key: "name", label: "Name", type: "text" as const, required: true },
  { key: "description", label: "Description", type: "textarea" as const },
];

export default async function CancelReasonsAdminPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
  const userIsAdmin = isAdmin(session.user.role);

  if (activeWorkspace.isAllSelected) {
    if (!userIsAdmin) redirect("/dashboard");
    const departments = (await listDepartments()).map((d) => ({ id: d.id, name: d.name }));
    const reasons = await prisma.ticketCancelReason.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { tickets: true } }, department: { select: { id: true, name: true } } },
    });
    return (
      <PageShell>
        <WorkspaceConfigManager
          entityLabel="Cancel Reason"
          entityLabelPlural="Cancel Reasons"
          apiEndpoint="/api/admin/cancel-reasons"
          items={reasons as any}
          fields={CANCEL_REASON_FIELDS}
          departmentOptions={departments}
          mode="all"
          canCreateGlobal={true}
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
    access = await requireAnyDepartmentPermission(departmentId, CANCEL_REASON_PERMISSION_KEYS);
  } catch {
    redirect("/dashboard");
  }

  const reasons = await prisma.ticketCancelReason.findMany({
    where: buildCancelReasonWhere(departmentId),
    orderBy: { name: "asc" },
    include: { _count: { select: { tickets: true } }, department: { select: { id: true, name: true } } },
  });
  const departmentOptions = userIsAdmin ? (await listDepartments()).map((d) => ({ id: d.id, name: d.name })) : [];
  const [canCreate, canEdit, canDelete] = await Promise.all([
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "cancelReason.create", access.membership!.customRoleId),
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "cancelReason.edit", access.membership!.customRoleId),
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "cancelReason.delete", access.membership!.customRoleId),
  ]);

  return (
    <PageShell>
      <WorkspaceConfigManager
        entityLabel="Cancel Reason"
        entityLabelPlural="Cancel Reasons"
        apiEndpoint="/api/admin/cancel-reasons"
        items={reasons as any}
        fields={CANCEL_REASON_FIELDS}
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
        <h1 className="text-2xl font-bold">Cancel Reasons</h1>
        <p className="text-muted-foreground mt-1">
          Manage reasons available when cancelling a ticket for the current workspace — switch workspace in the top nav to manage another department.
        </p>
      </div>
      {children}
    </div>
  );
}
