import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildProjectListWhere, hasEffectiveModulePermission } from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { NoWorkspaceState, ChooseWorkspaceState } from "@/components/workspace/workspace-gate";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft, GanttChartSquare, ShieldOff } from "lucide-react";
import { GanttChart, GanttGroup, GanttDependency } from "@/components/gantt/gantt-chart";
import { getProgressConfigsForDepartments, resolveProgressPercentOrNull } from "@/lib/activities/activity-progress";
import { getProjectTerminalConfigsForDepartments, getActivityTerminalConfigsForDepartments, resolveProjectTerminal, resolveActivityTerminal } from "@/lib/status-terminal";
import { getActivityStatusDisplayConfigsForDepartments, resolveActivityStatusDisplay } from "@/lib/services/activity-status-config";
import { isProjectOverdue, isActivityOverdue } from "@/lib/overdue";
import { projectPriorityKey } from "@/lib/project-priority";
import { getActivityPriorityConfigsForDepartments, buildPriorityFilterOptions } from "@/lib/priority-config";

interface SearchParams {
  status?: string;
  projectId?: string;
  userId?: string;
  departmentId?: string;
  from?: string;
  to?: string;
}

export default async function ProjectGanttPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  // Project Gantt access = effective gantt.view AND effective project.view.
  // gantt.view is a capability gate for the Gantt UI itself, never a
  // replacement for the underlying entity-view authorization — an admin
  // can revoke it to hide Gantt for a role while that role keeps normal
  // project.view (list/detail) access. Both checks use the same GLOBAL-
  // grant-OR-qualifying-active-department-grant union
  // getNavVisibilityFlags already applies to the sidebar's own "Project
  // Gantt" link; a plain global-only hasPermission check here previously
  // blocked a user whose project.view grant is department-scoped only.
  // Department DATA scoping (buildProjectListWhere below) is completely
  // unaffected by either check.
  const [canViewGantt, canViewProjects] = await Promise.all([
    hasEffectiveModulePermission(session.user.id, session.user.role, session.user.customRoleId, "gantt.view"),
    hasEffectiveModulePermission(session.user.id, session.user.role, session.user.customRoleId, "project.view"),
  ]);
  if (!canViewGantt || !canViewProjects) redirect("/dashboard");

  const params = await searchParams;

  // Active workspace is the default scope (Phase 2B); an explicit
  // ?departmentId= is still honored as a one-off "explicit scoped view" but
  // never persisted as the active workspace itself — switching workspace is
  // exclusively done via the selector/gate, which call the workspace API.
  const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
  const effectiveDepartmentId =
    params.departmentId ?? (activeWorkspace.isAllSelected ? undefined : activeWorkspace.departmentId);

  if (!effectiveDepartmentId && !activeWorkspace.isAllSelected) {
    return activeWorkspace.departments.length === 0 ? (
      <NoWorkspaceState />
    ) : (
      <ChooseWorkspaceState departments={activeWorkspace.departments} />
    );
  }

  // Department scoping is validated server-side here, not trusted from the
  // URL — an out-of-scope ?departmentId= renders an access-denied message
  // below rather than leaking that department's projects.
  const scope = await buildProjectListWhere(session.user.id, session.user.role, effectiveDepartmentId);
  if ("denied" in scope) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center gap-4">
        <ShieldOff className="h-12 w-12 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Access denied</h1>
        <p className="text-muted-foreground text-sm max-w-sm">
          You don&apos;t have access to that department.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/projects/gantt">View my Gantt</Link>
        </Button>
      </div>
    );
  }

  const andConditions: any[] = [scope];
  if (params.status) andConditions.push({ status: params.status });
  if (params.userId) andConditions.push({ ownerId: params.userId });
  if (params.from || params.to) {
    andConditions.push({
      OR: [
        {
          startDate: {
            ...(params.from ? { gte: new Date(params.from) } : {}),
            ...(params.to ? { lte: new Date(params.to) } : {}),
          },
        },
        {
          endDate: {
            ...(params.from ? { gte: new Date(params.from) } : {}),
            ...(params.to ? { lte: new Date(params.to) } : {}),
          },
        },
      ],
    });
  }
  const where: any = { AND: andConditions };

  const projects = await prisma.project.findMany({
    where,
    orderBy: { startDate: "asc" },
    include: {
      owner: { select: { id: true, name: true, image: true } },
      activities: {
        orderBy: { startDate: "asc" },
        include: {
          assignedUsers: { select: { id: true, name: true, image: true } },
        },
        ...(params.projectId ? { where: { projectId: params.projectId } } : {}),
      },
    },
  });

  // Collect all activity IDs to fetch their dependencies
  const activityIds = projects.flatMap((p) => p.activities.map((a) => a.id));
  const rawDeps = activityIds.length > 0
    ? await prisma.activityDependency.findMany({
        where: { OR: [{ predecessorId: { in: activityIds } }, { successorId: { in: activityIds } }] },
        select: { id: true, predecessorId: true, successorId: true, type: true },
      })
    : [];
  const dependencies: GanttDependency[] = rawDeps.map((d) => ({
    id: d.id,
    predecessorId: d.predecessorId,
    successorId:   d.successorId,
    type: d.type as GanttDependency["type"],
  }));

  // Activity progress is derived from status (per-department configurable —
  // see lib/activities/activity-progress.ts), so it's resolved fresh here
  // rather than trusting the possibly-stale stored column. Project progress
  // (below) has no such per-status formula — it stays the stored average.
  const activityDepartmentIds = projects.flatMap((p) => p.activities.map((a) => a.departmentId).filter((id): id is string => !!id));
  const projectDepartmentIds = projects.map((p) => p.departmentId).filter((id): id is string => !!id);
  const progressConfigs = await getProgressConfigsForDepartments(activityDepartmentIds);
  const statusDisplayConfigs = await getActivityStatusDisplayConfigsForDepartments(activityDepartmentIds);

  // Overdue (Part 2) — derived here once, from each entity's own department's
  // terminal-status configuration (lib/status-terminal.ts), never stored.
  // Project has no literal `dueDate` field; its functional due date is
  // `endDate` (the project's own end-of-work date).
  const [projectTerminalConfigs, activityTerminalConfigs] = await Promise.all([
    getProjectTerminalConfigsForDepartments(projectDepartmentIds),
    getActivityTerminalConfigsForDepartments(activityDepartmentIds),
  ]);
  const now = new Date();

  // Priority filter options (Part 1 corrective) — the department's OWN
  // configured order/enablement (ActivityPriorityConfig via
  // lib/priority-config.ts), never the hardcoded canonical order. Only
  // resolvable for a single specific department; "All Workspaces" (no
  // single effectiveDepartmentId) has no one department's config to honor
  // — GanttChart falls back to its own canonical-order constant in that
  // case, the same documented limitation app/(main)/dashboard/page.tsx
  // already accepts for "All Workspaces" ticket status/priority charts.
  const priorityOptions = effectiveDepartmentId
    ? buildPriorityFilterOptions(
        await getActivityPriorityConfigsForDepartments([effectiveDepartmentId]),
        effectiveDepartmentId
      )
    : undefined;

  // Drag-to-reschedule capability hint — same union rule as `canView` above,
  // checked against project.edit rather than a raw isAdmin(role)/role===ADMIN
  // check (the exact anti-pattern this fix removes): a DEPARTMENT_ADMIN (or
  // anyone else holding project.edit only via a DepartmentMembership) can
  // now see the drag affordance too, not just a global System Admin. This
  // is a UI hint only — PATCH /api/projects/[id] (what an actual drag
  // ultimately calls) independently re-checks project.edit per-project via
  // canActOnEntity and remains the real authority, so a user who can edit
  // in SOME but not all of the departments shown here is still correctly
  // rejected per-row by the backend if they drag one they don't hold it in.
  const canEditProjects = await hasEffectiveModulePermission(session.user.id, session.user.role, session.user.customRoleId, "project.edit");

  const groups: GanttGroup[] = projects.map((p) => ({
    id: p.id,
    title: p.title,
    href: `/projects/${p.id}`,
    status: p.status,
    priority: projectPriorityKey(p.priority),
    startDate: p.startDate?.toISOString() ?? null,
    endDate: p.endDate?.toISOString() ?? null,
    progress: p.progress,
    ownerName: p.owner.name,
    ownerImage: p.owner.image,
    type: "project",
    overdue: isProjectOverdue(p.endDate, resolveProjectTerminal(projectTerminalConfigs, p.departmentId, p.status), now),
    children: p.activities.map((a) => ({
      id: a.id,
      title: a.title,
      status: a.status,
      statusLabel: resolveActivityStatusDisplay(statusDisplayConfigs, a.departmentId, a.status).label,
      statusColor: resolveActivityStatusDisplay(statusDisplayConfigs, a.departmentId, a.status).color,
      startDate: a.isMilestone
        ? (a.dueDate?.toISOString() ?? null)
        : (a.startDate?.toISOString() ?? null),
      endDate: a.dueDate?.toISOString() ?? null,
      progress: resolveProgressPercentOrNull(progressConfigs, a.departmentId, a.status),
      href: `/activities/${a.id}`,
      priority: a.priority,
      assigneeName: a.assignedUsers[0]?.name ?? null,
      assigneeImage: a.assignedUsers[0]?.image ?? null,
      type: (a.isMilestone ? "milestone" : "activity") as "milestone" | "activity",
      overdue: isActivityOverdue(a.dueDate, resolveActivityTerminal(activityTerminalConfigs, a.departmentId, a.status), now),
    })),
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/projects">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Projects
          </Link>
        </Button>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <GanttChartSquare className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Project Gantt</h1>
            <p className="text-muted-foreground text-sm">
              {projects.length} project{projects.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
      </div>

      <GanttChart
        groups={groups}
        canEdit={canEditProjects}
        dependencies={dependencies}
        priorityOptions={priorityOptions}
        activityStatusLegendEntries={
          effectiveDepartmentId
            ? Object.entries(statusDisplayConfigs[effectiveDepartmentId] ?? {})
                .sort(([, a], [, b]) => a!.sortOrder - b!.sortOrder)
                .map(([key, row]) => ({ key, label: row!.label, color: row!.color }))
            : undefined
        }
      />
    </div>
  );
}
