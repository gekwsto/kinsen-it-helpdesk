import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { isAdmin, requireAnyDepartmentPermission, hasDepartmentPermission } from "@/lib/permissions";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { listDepartments } from "@/lib/services/department-service";
import { buildPriorityWhere } from "@/lib/services/department-scope-service";
import { NoWorkspaceState, ChooseWorkspaceState } from "@/components/workspace/workspace-gate";
import { WorkspaceSlaManager } from "@/components/admin/workspace-sla-manager";

const SLA_PERMISSION_KEYS = ["sla.create", "sla.edit", "sla.delete"];

function toPriorityPolicy(p: any) {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    level: p.level,
    departmentId: p.departmentId,
    department: p.department ?? null,
    firstResponseHours: p.slaPolicy?.firstResponseHours ?? 8,
    resolutionHours: p.slaPolicy?.resolutionHours ?? 48,
    hasPolicy: p.slaPolicy != null,
  };
}

export default async function SlaAdminPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
  const userIsAdmin = isAdmin(session.user.role);

  if (activeWorkspace.isAllSelected) {
    if (!userIsAdmin) redirect("/dashboard");
    const [settings, priorities, departments] = await Promise.all([
      prisma.slaSettings.findFirst(),
      prisma.ticketPriority.findMany({
        where: { isActive: true },
        orderBy: { level: "desc" },
        include: { slaPolicy: true, department: { select: { id: true, name: true } } },
      }),
      listDepartments(),
    ]);
    return (
      <PageShell>
        <WorkspaceSlaManager
          isEnabled={settings?.isEnabled ?? false}
          priorities={priorities.map(toPriorityPolicy)}
          departmentOptions={departments.map((d) => ({ id: d.id, name: d.name }))}
          mode="all"
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
    access = await requireAnyDepartmentPermission(departmentId, SLA_PERMISSION_KEYS);
  } catch {
    redirect("/dashboard");
  }

  const [settings, priorities, departments, canEdit, canDelete] = await Promise.all([
    prisma.slaSettings.findFirst(),
    prisma.ticketPriority.findMany({
      where: { AND: [{ isActive: true }, buildPriorityWhere(departmentId)] },
      orderBy: { level: "desc" },
      include: { slaPolicy: true, department: { select: { id: true, name: true } } },
    }),
    userIsAdmin ? listDepartments() : Promise.resolve([]),
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "sla.edit", access.membership!.customRoleId),
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "sla.delete", access.membership!.customRoleId),
  ]);

  return (
    <PageShell>
      <WorkspaceSlaManager
        isEnabled={settings?.isEnabled ?? false}
        priorities={priorities.map(toPriorityPolicy)}
        departmentOptions={departments.map((d) => ({ id: d.id, name: d.name }))}
        fixedDepartmentId={userIsAdmin ? undefined : departmentId}
        initialViewDepartmentId={departmentId}
        mode="scoped"
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
        <h1 className="text-2xl font-bold">SLA Configuration</h1>
        <p className="text-muted-foreground mt-1">
          Set response and resolution time targets per ticket priority for the current workspace.
        </p>
      </div>
      {children}
    </div>
  );
}
