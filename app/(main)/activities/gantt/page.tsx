import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission, canManageProjects } from "@/lib/permissions";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft, GanttChartSquare } from "lucide-react";
import { GanttChart, GanttGroup } from "@/components/gantt/gantt-chart";

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

  const where: any = {};
  if (params.status) where.status = params.status;
  if (params.projectId) where.projectId = params.projectId;
  if (params.userId) where.assignedUsers = { some: { id: params.userId } };
  if (params.departmentId) where.departmentId = params.departmentId;
  if (params.from || params.to) {
    where.OR = [
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
    ];
  }

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
      startDate: a.startDate?.toISOString() ?? null,
      endDate: a.dueDate?.toISOString() ?? null,
      progress: a.progress,
      href: `/activities/${a.id}`,
      assigneeName: a.assignedUsers[0]?.name ?? null,
      assigneeImage: a.assignedUsers[0]?.image ?? null,
      type: "activity" as const,
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

      <GanttChart groups={groups} />
    </div>
  );
}
