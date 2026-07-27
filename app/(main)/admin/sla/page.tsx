import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { isAdmin, requireAnyDepartmentPermission, hasDepartmentPermission } from "@/lib/permissions";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { listDepartments } from "@/lib/services/department-service";
import { buildPriorityWhere } from "@/lib/services/department-scope-service";
import { NoWorkspaceState, ChooseWorkspaceState } from "@/components/workspace/workspace-gate";
import { WorkspaceSlaManager } from "@/components/admin/workspace-sla-manager";
import { resolveSlaHoursFromRelation } from "@/lib/services/sla-policy";

const SLA_PERMISSION_KEYS = ["sla.create", "sla.edit", "sla.delete"];

function toPriorityPolicy(p: any) {
  const resolution = resolveSlaHoursFromRelation(p.slaPolicy, p.id);
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    level: p.level,
    isActive: p.isActive,
    departmentId: p.departmentId,
    department: p.department ?? null,
    // null means no SlaPolicy row exists — the UI MUST render "SLA not
    // configured", never fabricate 8h/48h as if it were real data.
    firstResponseHours: resolution.ok ? resolution.hours.firstResponseHours : null,
    resolutionHours: resolution.ok ? resolution.hours.resolutionHours : null,
    hasPolicy: resolution.ok,
    ticketCount: p._count?.tickets ?? 0,
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
      // Admin management view intentionally includes disabled levels too
      // (not just active ones) — an admin must be able to see, re-enable,
      // or safely delete a disabled level here. Ticket-creation dropdowns
      // elsewhere already filter to isActive:true on their own.
      prisma.ticketPriority.findMany({
        orderBy: { level: "desc" },
        include: { slaPolicy: true, department: { select: { id: true, name: true } }, _count: { select: { tickets: true } } },
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
    access = await requireAnyDepartmentPermission(departmentId, SLA_PERMISSION_KEYS);
  } catch {
    redirect("/dashboard");
  }

  const [settings, priorities, departments, canCreate, canEdit, canDelete] = await Promise.all([
    prisma.slaSettings.findFirst(),
    prisma.ticketPriority.findMany({
      where: buildPriorityWhere(departmentId),
      orderBy: { level: "desc" },
      include: { slaPolicy: true, department: { select: { id: true, name: true } }, _count: { select: { tickets: true } } },
    }),
    userIsAdmin ? listDepartments() : Promise.resolve([]),
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "sla.create", access.membership!.customRoleId),
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
        <h1 className="text-2xl font-bold">SLA Configuration</h1>
        <p className="text-muted-foreground mt-1">
          Set response and resolution time targets per ticket priority for the current workspace.
        </p>
      </div>
      {children}
    </div>
  );
}
