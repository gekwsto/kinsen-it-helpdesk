import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { buildProjectListWhere } from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { NoWorkspaceState, ChooseWorkspaceState } from "@/components/workspace/workspace-gate";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, FolderKanban, Calendar, Users } from "lucide-react";
import { formatDate } from "@/lib/utils";
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

export default async function ProjectsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const canView = await hasPermission(session.user.role, "project.view", session.user.customRoleId);
  if (!canView) {
    redirect("/dashboard");
  }

  const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
  if (!activeWorkspace.departmentId) {
    return activeWorkspace.departments.length === 0 ? (
      <NoWorkspaceState />
    ) : (
      <ChooseWorkspaceState departments={activeWorkspace.departments} />
    );
  }

  const scope = await buildProjectListWhere(session.user.id, session.user.role, activeWorkspace.departmentId);
  const where = "denied" in scope ? { id: { in: [] as string[] } } : scope;

  const projects = await prisma.project.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      owner: { select: { id: true, name: true, image: true } },
      department: { select: { id: true, name: true } },
      members: { select: { id: true, name: true, image: true } },
      _count: { select: { activities: true } },
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="text-muted-foreground mt-1">
            Manage IT projects and initiatives
          </p>
        </div>
        <Button asChild>
          <Link href="/projects/new">
            <Plus className="h-4 w-4 mr-2" />
            New Project
          </Link>
        </Button>
      </div>

      {projects.length === 0 ? (
        <div className="text-center py-20">
          <FolderKanban className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">No projects yet.</p>
          <Button asChild className="mt-4">
            <Link href="/projects/new">Create First Project</Link>
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <Link key={project.id} href={`/projects/${project.id}`}>
              <Card className="h-full hover:shadow-md transition-shadow cursor-pointer">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base line-clamp-2">
                      {project.title}
                    </CardTitle>
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS_COLORS[project.status]}`}
                    >
                      {project.status.replace("_", " ")}
                    </span>
                  </div>
                  {project.description && (
                    <CardDescription className="line-clamp-2">
                      {project.description}
                    </CardDescription>
                  )}
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    {project.department && (
                      <span>{project.department.name}</span>
                    )}
                    <Badge variant="outline" className="text-xs">
                      Priority {PRIORITY_LABELS[project.priority]}
                    </Badge>
                  </div>

                  {(project.startDate || project.endDate) && (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Calendar className="h-3.5 w-3.5" />
                      {project.startDate && formatDate(project.startDate)}
                      {project.startDate && project.endDate && " → "}
                      {project.endDate && formatDate(project.endDate)}
                    </div>
                  )}

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Users className="h-3.5 w-3.5" />
                      {project.members.length} member{project.members.length !== 1 ? "s" : ""}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {project._count.activities} activities
                    </span>
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
