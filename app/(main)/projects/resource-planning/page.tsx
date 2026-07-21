import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { getAccessibleDepartmentSummaries, canActOnEntity } from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { getResourcePlanningData } from "@/lib/services/resource-planning-service";
import { DEPARTMENT_ROLE_LABELS, GLOBAL_ROLE_LABELS } from "@/lib/services/department-role-translation";
import { redirect } from "next/navigation";
import { CalendarRange, ShieldOff, Building2 } from "lucide-react";
import { ActivityStatus, ActivityPriority } from "@prisma/client";
import { addDays, addWeeks, addMonths, startOfWeek, startOfMonth, endOfMonth, format } from "date-fns";
import { ResourcePlanningFilters } from "@/components/resource-planning/resource-planning-filters";
import { ResourcePlanningToolbar, type ResourcePlanningView } from "@/components/resource-planning/resource-planning-toolbar";
import { ResourceTimeline, type ResourceRow } from "@/components/resource-planning/resource-timeline";
import { UnscheduledPanel } from "@/components/resource-planning/unscheduled-panel";

interface SearchParams {
  departmentId?: string;
  subDepartmentId?: string;
  projectId?: string;
  status?: string;
  priority?: string;
  view?: string;
  from?: string;
}

/** v1, count-based (no hours/estimate field exists on ProjectActivity — see the architecture plan). Thresholds are approximate and labeled as such in the UI, never shown as fake precision. */
function utilizationFor(count: number): { count: number; label: string; className: string } {
  if (count === 0) return { count, label: "Idle", className: "bg-muted text-muted-foreground" };
  if (count <= 2) return { count, label: "Low", className: "bg-emerald-100 text-emerald-700" };
  if (count <= 5) return { count, label: "Normal", className: "bg-blue-100 text-blue-700" };
  if (count <= 8) return { count, label: "High", className: "bg-amber-100 text-amber-700" };
  return { count, label: "Overloaded", className: "bg-red-100 text-red-700" };
}

export default async function ResourcePlanningPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const canView = await hasPermission(session.user.role, "resourcePlanning.view", session.user.customRoleId);
  if (!canView) redirect("/dashboard");

  const params = await searchParams;

  const accessibleDepartments = await getAccessibleDepartmentSummaries(session.user.id, session.user.role, "resourcePlanning.view");

  if (accessibleDepartments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center gap-4">
        <ShieldOff className="h-12 w-12 text-muted-foreground" />
        <h1 className="text-xl font-semibold">No accessible department</h1>
        <p className="text-muted-foreground text-sm max-w-sm">
          You don&apos;t have resource planning access in any department yet.
        </p>
      </div>
    );
  }

  let departmentId = params.departmentId;
  if (departmentId && !accessibleDepartments.some((d) => d.id === departmentId)) {
    departmentId = undefined; // out-of-scope id in the URL — fall through to a safe default below
  }
  if (!departmentId) {
    const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
    departmentId =
      (activeWorkspace.departmentId && accessibleDepartments.some((d) => d.id === activeWorkspace.departmentId)
        ? activeWorkspace.departmentId
        : undefined) ?? accessibleDepartments[0].id;
  }

  const subDepartmentId = params.subDepartmentId || undefined;
  const projectId = params.projectId || undefined;
  const status =
    params.status && (Object.values(ActivityStatus) as string[]).includes(params.status)
      ? (params.status as ActivityStatus)
      : undefined;
  const priority =
    params.priority && (Object.values(ActivityPriority) as string[]).includes(params.priority)
      ? (params.priority as ActivityPriority)
      : undefined;

  // URL-driven view/date range (architecture plan Decision #2) — Prev/Next/
  // Today/view-toggle in ResourcePlanningToolbar all push `view`/`from` and
  // land back here, causing a fresh server-side range computation + fetch.
  const view: ResourcePlanningView = params.view === "month" ? "month" : "week";
  const anchor = params.from ? new Date(params.from) : new Date();
  const rangeStart = view === "week" ? startOfWeek(anchor, { weekStartsOn: 1 }) : startOfMonth(anchor);
  const rangeEnd = view === "week" ? addDays(rangeStart, 6) : endOfMonth(rangeStart);
  const rangeLabel =
    view === "week" ? `${format(rangeStart, "d MMM")} – ${format(rangeEnd, "d MMM yyyy")}` : format(rangeStart, "MMMM yyyy");

  const [result, projects, canEdit] = await Promise.all([
    getResourcePlanningData(
      { userId: session.user.id, role: session.user.role, customRoleId: session.user.customRoleId },
      { departmentId, subDepartmentId, projectId, status, priority, rangeStart, rangeEnd }
    ),
    prisma.project.findMany({ where: { departmentId }, select: { id: true, title: true }, orderBy: { title: "asc" } }),
    // resourcePlanning.view never implies edit — this is the same
    // canActOnEntity(..., "activity.edit") check PATCH /api/activities/[id]
    // itself re-validates, computed once for the single resolved department
    // this page always operates on.
    canActOnEntity(session.user.id, session.user.role, departmentId, "activity.edit"),
  ]);

  if (result.denied) redirect("/dashboard");

  const { resources, events, unscheduled } = result;
  const resourceIds = resources.map((r) => r.id);

  // Department-role label per resource — DepartmentMembership first (real
  // per-department standing), falling back to the global Role label only
  // for a resource reached via the cross-department bypass with no
  // membership row here (e.g. an Admin/Director who happens to be
  // activity/project-assignable without being a department member).
  const [memberships, usersWithoutMembership] = await Promise.all([
    resourceIds.length > 0
      ? prisma.departmentMembership.findMany({
          where: { departmentId, userId: { in: resourceIds }, isActive: true },
          select: { userId: true, role: true, customRole: { select: { name: true } } },
        })
      : Promise.resolve([]),
    resourceIds.length > 0 ? prisma.user.findMany({ where: { id: { in: resourceIds } }, select: { id: true, role: true } }) : Promise.resolve([]),
  ]);
  const membershipByUserId = new Map(memberships.map((m) => [m.userId, m]));
  const globalRoleByUserId = new Map(usersWithoutMembership.map((u) => [u.id, u.role]));

  const rangeEvents = events; // already the current-window events per getResourcePlanningData

  const resourceRows: ResourceRow[] = resources.map((r) => {
    const membership = membershipByUserId.get(r.id);
    const roleLabel = membership
      ? (membership.customRole?.name ?? DEPARTMENT_ROLE_LABELS[membership.role])
      : (GLOBAL_ROLE_LABELS[globalRoleByUserId.get(r.id)!] ?? "—");
    const count = rangeEvents.filter((e) => e.assignedUserIds.includes(r.id)).length;
    return { ...r, roleLabel, utilization: utilizationFor(count) };
  });

  const selectedDepartment = accessibleDepartments.find((d) => d.id === departmentId)!;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
          <CalendarRange className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Resource Planning</h1>
          <p className="text-muted-foreground mt-0.5">
            Plan department resources across projects and activities.
          </p>
        </div>
      </div>

      {/* Two-region planning board: [filters + unscheduled rail] [main timeline].
          ResourcePlanningFilters owns the entire lg+ rail (Filters card +
          Unscheduled card stacked, see that component) as well as the
          below-lg "Filters" button/dialog, so this row only ever has to
          place it once. The main column is flex-1/min-w-0 so the timeline
          takes all remaining width — no right-hand rail reserved for it
          anymore. */}
      <div className="flex flex-col lg:flex-row gap-4 items-start">
        <ResourcePlanningFilters
          departments={accessibleDepartments}
          selectedDepartmentId={departmentId}
          projects={projects}
          selectedProjectId={projectId}
          selectedStatus={status}
          selectedPriority={priority}
          unscheduled={unscheduled}
          resources={resources}
        />

        <div className="flex-1 min-w-0 space-y-3">
          <ResourcePlanningToolbar view={view} rangeStart={format(rangeStart, "yyyy-MM-dd")} rangeLabel={rangeLabel} />

          {resourceRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border py-16 text-center text-muted-foreground">
              <Building2 className="h-8 w-8" />
              <p className="text-sm">
                No assignable agents found for {selectedDepartment.name}
                {subDepartmentId ? " in this sub-department" : ""}.
              </p>
            </div>
          ) : (
            <ResourceTimeline resources={resourceRows} events={rangeEvents} rangeStart={rangeStart} rangeEnd={rangeEnd} view={view} canEdit={canEdit} />
          )}

          {/* Below lg, Unscheduled isn't part of the (hidden) rail — shown
              here instead, stacked below the timeline. */}
          <div className="lg:hidden">
            <UnscheduledPanel unscheduled={unscheduled} resources={resources} />
          </div>
        </div>
      </div>
    </div>
  );
}
