import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
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

  const where: any = {};
  if (params.status) where.status = params.status;
  if (params.departmentId) where.departmentId = params.departmentId;
  if (params.userId) where.ownerId = params.userId;
  if (params.from || params.to) {
    where.OR = [
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
    ];
  }

  const projects = await prisma.project.findMany({
    where,
    orderBy: { startDate: "asc" },
    include: {
      owner: { select: { id: true, name: true, image: true } },
      activities: {
        orderBy: { startDate: "asc" },
        include: {
          assignedUser: { select: { id: true, name: true, image: true } },
        },
        ...(params.projectId ? { where: { projectId: params.projectId } } : {}),
      },
    },
  });

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
      startDate: a.startDate?.toISOString() ?? null,
      endDate: a.dueDate?.toISOString() ?? null,
      progress: a.progress,
      href: `/activities/${a.id}`,
      assigneeName: a.assignedUser?.name ?? null,
      assigneeImage: a.assignedUser?.image ?? null,
      type: "activity" as const,
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

      <GanttChart groups={groups} />
    </div>
  );
}
