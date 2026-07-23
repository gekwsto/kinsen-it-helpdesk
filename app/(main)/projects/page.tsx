import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { buildProjectListWhere } from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { NoWorkspaceState, ChooseWorkspaceState } from "@/components/workspace/workspace-gate";
import { SubDepartmentFilter } from "@/components/workspace/sub-department-filter";
import { ViewToggle } from "@/components/ui/view-toggle";
import { ProjectList } from "@/components/projects/project-list";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Plus, FolderKanban } from "lucide-react";

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ subDepartmentId?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const params = await searchParams;

  const canView = await hasPermission(session.user.role, "project.view", session.user.customRoleId);
  if (!canView) {
    redirect("/dashboard");
  }

  const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
  if (!activeWorkspace.departmentId && !activeWorkspace.isAllSelected) {
    return activeWorkspace.departments.length === 0 ? (
      <NoWorkspaceState />
    ) : (
      <ChooseWorkspaceState departments={activeWorkspace.departments} />
    );
  }

  const scope = await buildProjectListWhere(
    session.user.id,
    session.user.role,
    activeWorkspace.isAllSelected ? undefined : activeWorkspace.departmentId
  );
  const baseWhere = "denied" in scope ? { id: { in: [] as string[] } } : scope;
  const where = params.subDepartmentId ? { AND: [baseWhere, { subDepartmentId: params.subDepartmentId }] } : baseWhere;

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
        <div className="flex items-center gap-2">
          <ViewToggle />
          <SubDepartmentFilter departmentId={activeWorkspace.isAllSelected ? null : activeWorkspace.departmentId} />
          <Button asChild>
            <Link href="/projects/new">
              <Plus className="h-4 w-4 mr-2" />
              New Project
            </Link>
          </Button>
        </div>
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
        <ProjectList projects={projects} />
      )}
    </div>
  );
}
