import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/permissions";
import { getProjectStatusUsageCounts, listProjectStatusDefinitions } from "@/lib/services/project-status-service";
import { ProjectStatusManager } from "@/components/admin/project-status-manager";

/**
 * Administration -> Project Statuses — ADMIN only (the API re-checks).
 * One GLOBAL set shared by every Workspace; see
 * lib/services/project-status-service.ts for the model and protections.
 */
export default async function ProjectStatusesAdminPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!isAdmin(session.user.role)) redirect("/dashboard");

  const [definitions, usage] = await Promise.all([listProjectStatusDefinitions(), getProjectStatusUsageCounts()]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Project Statuses</h1>
        <p className="text-muted-foreground mt-1">
          Configure the Project Statuses shown across every Workspace. Each status represents a lifecycle state, which drives completion, Feedback and overdue rules.
        </p>
      </div>
      <ProjectStatusManager initialStatuses={definitions.map((d) => ({ ...d, usageCount: usage[d.id] ?? 0 }))} />
    </div>
  );
}
