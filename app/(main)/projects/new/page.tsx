import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission } from "@/lib/permissions";
import { getAccessibleDepartmentSummaries } from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { Button } from "@/components/ui/button";
import { ProjectForm } from "@/components/projects/project-form";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";

export default async function NewProjectPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const canCreate = await hasPermission(session.user.role, "project.create", session.user.customRoleId);
  if (!canCreate) redirect("/projects");

  // Only departments this user can actually create a project in — the same
  // set resolveDepartmentForCreate (lib/services/department-scope-service.ts)
  // validates against on submit, so the dropdown never offers a choice the
  // API would reject.
  const [departments, activeWorkspace] = await Promise.all([
    getAccessibleDepartmentSummaries(session.user.id, session.user.role, "project.create"),
    getActiveWorkspace(session.user.id, session.user.role),
  ]);

  // Preselect the active workspace if it's actually allowed; if there's
  // exactly one allowed department, that's the obvious choice regardless of
  // workspace state. Otherwise (multiple choices, or "All Workspaces"
  // selected) leave it unselected — the form requires an explicit pick.
  const activeIsAllowed =
    activeWorkspace.departmentId != null && departments.some((d) => d.id === activeWorkspace.departmentId);
  const defaultDepartmentId = activeIsAllowed
    ? (activeWorkspace.departmentId as string)
    : departments.length === 1
    ? departments[0].id
    : undefined;

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/projects">
            <ChevronLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold">New Project</h1>
          <p className="text-muted-foreground mt-1">Create a new IT project</p>
        </div>
      </div>

      <ProjectForm departments={departments} defaultDepartmentId={defaultDepartmentId} />
    </div>
  );
}
