import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission, isAdmin } from "@/lib/permissions";
import { buildProjectListWhere } from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { NoWorkspaceState, ChooseWorkspaceState } from "@/components/workspace/workspace-gate";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft, GanttChartSquare, ShieldOff } from "lucide-react";
import { GanttChart, GanttGroup, GanttDependency } from "@/components/gantt/gantt-chart";
import { getProgressConfigsForDepartments, resolveProgress } from "@/lib/activities/activity-progress";

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
  const canView = await hasPermission(session.user.role, "project.view", session.user.customRoleId);
  if (!canView) redirect("/dashboard");

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
  const progressConfigs = await getProgressConfigsForDepartments(activityDepartmentIds);

  const groups: GanttGroup[] = projects.map((p) => ({
    id: p.id,
    title: p.title,
    href: `/projects/${p.id}`,
    status: p.status,
    startDate: p.startDate?.toISOString() ?? null,
    endDate: p.endDate?.toISOString() ?? null,
    progress: p.progress,
    ownerName: p.owner.name,
    ownerImage: p.owner.image,
    type: "project",
    children: p.activities.map((a) => ({
      id: a.id,
      title: a.title,
      status: a.status,
      startDate: a.isMilestone
        ? (a.dueDate?.toISOString() ?? null)
        : (a.startDate?.toISOString() ?? null),
      endDate: a.dueDate?.toISOString() ?? null,
      progress: resolveProgress(progressConfigs, a.departmentId, a.status),
      href: `/activities/${a.id}`,
      priority: a.priority,
      assigneeName: a.assignedUsers[0]?.name ?? null,
      assigneeImage: a.assignedUsers[0]?.image ?? null,
      type: (a.isMilestone ? "milestone" : "activity") as "milestone" | "activity",
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

      <GanttChart groups={groups} canEdit={isAdmin(session.user.role)} dependencies={dependencies} />
    </div>
  );
}
