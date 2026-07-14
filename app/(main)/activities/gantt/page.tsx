import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission, canManageProjects, isAdmin } from "@/lib/permissions";
import { buildActivityListWhere } from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { NoWorkspaceState, ChooseWorkspaceState } from "@/components/workspace/workspace-gate";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft, GanttChartSquare, ShieldOff } from "lucide-react";
import { GanttChart, GanttGroup, GanttDependency } from "@/components/gantt/gantt-chart";

interface SearchParams {
  status?: string;
  projectId?: string;
  userId?: string;
  departmentId?: string;
  from?: string;
  to?: string;
}

export default async function ActivityGanttPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  if (!canManageProjects(session.user.role)) redirect("/dashboard");

  const canView = await hasPermission(
    session.user.role,
    "activity.view",
    session.user.customRoleId
  );
  if (!canView) redirect("/dashboard");

  const params = await searchParams;

  // Active workspace is the default scope (Phase 2B); an explicit
  // ?departmentId= is still honored as a one-off "explicit scoped view."
  const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
  const effectiveDepartmentId = params.departmentId ?? activeWorkspace.departmentId;

  if (!effectiveDepartmentId) {
    return activeWorkspace.departments.length === 0 ? (
      <NoWorkspaceState />
    ) : (
      <ChooseWorkspaceState departments={activeWorkspace.departments} />
    );
  }

  // Department scoping is validated server-side here, not trusted from the
  // URL — an out-of-scope ?departmentId= renders an access-denied message
  // below rather than leaking that department's activities.
  const scope = await buildActivityListWhere(session.user.id, session.user.role, effectiveDepartmentId);
  if ("denied" in scope) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center gap-4">
        <ShieldOff className="h-12 w-12 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Access denied</h1>
        <p className="text-muted-foreground text-sm max-w-sm">
          You don&apos;t have access to that department.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/activities/gantt">View my Gantt</Link>
        </Button>
      </div>
    );
  }

  const andConditions: any[] = [scope];
  if (params.status) andConditions.push({ status: params.status });
  if (params.projectId) andConditions.push({ projectId: params.projectId });
  if (params.userId) andConditions.push({ assignedUsers: { some: { id: params.userId } } });
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
          dueDate: {
            ...(params.from ? { gte: new Date(params.from) } : {}),
            ...(params.to ? { lte: new Date(params.to) } : {}),
          },
        },
      ],
    });
  }
  const where: any = { AND: andConditions };

  const activities = await prisma.projectActivity.findMany({
    where,
    orderBy: { startDate: "asc" },
    include: {
      project: { select: { id: true, title: true, status: true, startDate: true, endDate: true, progress: true, owner: { select: { id: true, name: true, image: true } } } },
      assignedUsers: { select: { id: true, name: true, image: true } },
    },
  });

  // Group by project; standalone activities get their own "group"
  const projectMap = new Map<string, GanttGroup>();
  const standaloneGroup: GanttGroup = {
    id: "standalone",
    title: "No Project",
    href: "/activities",
    status: "IN_PROGRESS",
    startDate: null,
    endDate: null,
    progress: 0,
    type: "standalone",
    children: [],
  };

  for (const a of activities) {
    const child = {
      id: a.id,
      title: a.title,
      status: a.status,
      startDate: a.isMilestone
        ? (a.dueDate?.toISOString() ?? null)
        : (a.startDate?.toISOString() ?? null),
      endDate: a.dueDate?.toISOString() ?? null,
      progress: a.progress,
      href: `/activities/${a.id}`,
      priority: a.priority,
      assigneeName: a.assignedUsers[0]?.name ?? null,
      assigneeImage: a.assignedUsers[0]?.image ?? null,
      type: (a.isMilestone ? "milestone" : "activity") as "milestone" | "activity",
    };

    if (!a.project) {
      standaloneGroup.children.push(child);
    } else {
      if (!projectMap.has(a.project.id)) {
        projectMap.set(a.project.id, {
          id: a.project.id,
          title: a.project.title,
          href: `/projects/${a.project.id}`,
          status: a.project.status,
          startDate: a.project.startDate?.toISOString() ?? null,
          endDate: a.project.endDate?.toISOString() ?? null,
          progress: a.project.progress,
          ownerName: a.project.owner.name,
          ownerImage: a.project.owner.image,
          type: "project",
          children: [],
        });
      }
      projectMap.get(a.project.id)!.children.push(child);
    }
  }

  const groups: GanttGroup[] = [
    ...projectMap.values(),
    ...(standaloneGroup.children.length > 0 ? [standaloneGroup] : []),
  ];

  const activityIds = activities.map((a) => a.id);
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

  const totalActivities = activities.length;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/activities">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Activities
          </Link>
        </Button>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <GanttChartSquare className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Activity Gantt</h1>
            <p className="text-muted-foreground text-sm">
              {totalActivities} activit{totalActivities !== 1 ? "ies" : "y"} across {groups.length} group{groups.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
      </div>

      <GanttChart groups={groups} canEdit={isAdmin(session.user.role)} dependencies={dependencies} />
    </div>
  );
}
