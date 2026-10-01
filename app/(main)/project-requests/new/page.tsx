import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { ProjectRequestForm } from "@/components/project-requests/project-request-form";
import { FileText } from "lucide-react";

export default async function NewProjectRequestPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // The SAME canonical accessible-departments set the workspace selector
  // itself uses (lib/services/workspace-service.ts) — a global-scope role
  // (ADMIN/DIRECTOR) reaches every active department even with zero direct
  // DepartmentMembership rows; everyone else sees only their own real,
  // active memberships. Previously this page queried
  // getUserDepartmentMemberships directly, which wrongly showed the "no
  // department" empty state for exactly that global-scope case — this is
  // the fix. `workspace.departmentId` is the already-selected active
  // workspace (cookie-resolved) — used ONLY as the form's default
  // selection, and ONLY when it's a real department (never the synthetic
  // "All Workspaces" state, where `isAllSelected` is true and
  // `departmentId` is null) — never as an authorization decision by
  // itself; the submit route re-verifies it regardless.
  const workspace = await getActiveWorkspace(session.user.id, session.user.role);
  const departments = workspace.departments;
  const defaultDepartmentId = workspace.isAllSelected ? undefined : workspace.departmentId ?? undefined;

  const activeTypesRaw = await prisma.projectRequestType.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, cost: true },
  });
  // Prisma.Decimal is a class instance, not a plain serializable value — it
  // cannot cross the Server -> Client Component boundary as-is. Converted
  // to a plain `number | null` here, once, before handing off to
  // <ProjectRequestForm>.
  const activeTypes = activeTypesRaw.map((t) => ({ ...t, cost: t.cost ? Number(t.cost) : null }));

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Project Request Form</h1>
        <p className="text-muted-foreground mt-1">
          Submit a request for a new Project — it will be routed to your manager, then to a system approver.
        </p>
      </div>

      {departments.length === 0 ? (
        <div className="text-center py-20 border rounded-lg">
          <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">
            You don&apos;t belong to any active department, so you can&apos;t submit a Project Request. Contact an
            administrator.
          </p>
        </div>
      ) : activeTypes.length === 0 ? (
        <div className="text-center py-20 border rounded-lg">
          <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">
            No Project Types have been configured yet. Contact an administrator before submitting a request.
          </p>
        </div>
      ) : (
        <ProjectRequestForm departments={departments} types={activeTypes} defaultDepartmentId={defaultDepartmentId} />
      )}
    </div>
  );
}
