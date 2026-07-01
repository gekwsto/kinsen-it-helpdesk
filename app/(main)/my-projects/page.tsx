import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatDate, getInitials } from "@/lib/utils";
import { FolderKanban, Plus } from "lucide-react";
import { ProjectStatus } from "@prisma/client";

const STATUS_COLORS: Record<ProjectStatus, string> = {
  PLANNING: "bg-blue-100 text-blue-700",
  IN_PROGRESS: "bg-amber-100 text-amber-700",
  ON_HOLD: "bg-orange-100 text-orange-700",
  COMPLETED: "bg-green-100 text-green-700",
  CANCELLED: "bg-gray-100 text-gray-700",
};

const PRIORITY_LABELS: Record<number, string> = {
  1: "Low",
  2: "Medium",
  3: "High",
};

export default async function MyProjectsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const canView = await hasPermission(session.user.role, "project.view", session.user.customRoleId);
  if (!canView) redirect("/dashboard");

  const canCreate = await hasPermission(session.user.role, "project.create", session.user.customRoleId);

  const userId = session.user.id;

  const projects = await prisma.project.findMany({
    where: {
      OR: [
        { ownerId: userId },
        { members: { some: { id: userId } } },
      ],
    },
    orderBy: { createdAt: "desc" },
    include: {
      owner: { select: { id: true, name: true, image: true } },
      members: { select: { id: true, name: true, image: true } },
      _count: { select: { activities: true } },
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">My Projects</h1>
          <p className="text-muted-foreground mt-1">Projects you own or are a member of</p>
        </div>
        {canCreate && (
          <Button asChild>
            <Link href="/projects/new">
              <Plus className="h-4 w-4 mr-2" />
              New Project
            </Link>
          </Button>
        )}
      </div>

      {projects.length === 0 ? (
        <div className="text-center py-20">
          <FolderKanban className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">No projects found.</p>
          {canCreate && (
            <Button asChild className="mt-4" variant="outline">
              <Link href="/projects/new">Create your first project</Link>
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {projects.map((project) => (
            <Link key={project.id} href={`/projects/${project.id}`}>
              <Card className="hover:shadow-sm transition-shadow cursor-pointer">
                <CardContent className="py-4 px-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[project.status]}`}
                        >
                          {project.status.replace(/_/g, " ")}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {PRIORITY_LABELS[project.priority] ?? "Medium"} priority
                        </span>
                      </div>
                      <p className="font-medium truncate">{project.title}</p>
                      <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                        <span>{project._count.activities} activities</span>
                        {project.endDate && (
                          <span>Due: {formatDate(project.endDate)}</span>
                        )}
                      </div>
                      {project.progress > 0 && (
                        <div className="mt-2 flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-muted rounded-full">
                            <div
                              className="h-1.5 bg-primary rounded-full"
                              style={{ width: `${project.progress}%` }}
                            />
                          </div>
                          <span className="text-xs text-muted-foreground">{project.progress}%</span>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {project.members.slice(0, 3).map((m) => (
                        <Avatar key={m.id} className="h-7 w-7 ring-2 ring-background -ml-1 first:ml-0">
                          <AvatarImage src={m.image ?? undefined} />
                          <AvatarFallback className="text-[9px]">
                            {getInitials(m.name)}
                          </AvatarFallback>
                        </Avatar>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
