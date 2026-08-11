import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { canActOnEntity } from "@/lib/services/department-scope-service";
import { ActivityNewForm } from "@/components/activities/activity-new-form";

export default async function NewActivityPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
  const departmentId = activeWorkspace.isAllSelected ? null : activeWorkspace.departmentId;

  // Same canActOnEntity gate POST /api/projects itself enforces (via
  // resolveDepartmentForCreate) — computed here only to decide whether the
  // form offers "+ New Project" at all; the backend remains authoritative.
  const canCreateProject = departmentId
    ? await canActOnEntity(session.user.id, session.user.role, departmentId, "project.create")
    : false;

  return <ActivityNewForm departmentId={departmentId} canCreateProject={canCreateProject} />;
}
