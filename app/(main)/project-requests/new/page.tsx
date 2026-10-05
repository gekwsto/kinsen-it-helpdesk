import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { getIntermediateApproverOptions } from "@/lib/services/project-request-service";
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

  const activeTypes = await prisma.projectRequestType.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  // Every real, currently-eligible intermediate approver, system-wide —
  // never department-scoped. This stage is mandatory (fail closed): if
  // nobody currently holds projectRequest.intermediateApprove, submission
  // must be blocked below rather than silently skipping the stage.
  const intermediateApproverOptions = await getIntermediateApproverOptions();

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Project Request Form</h1>
        <p className="text-muted-foreground mt-1">
          Submit a request for a new Project — select who should intermediate-approve it; once they all approve, it
          goes to final approval.
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
      ) : intermediateApproverOptions.length === 0 ? (
        <div className="text-center py-20 border rounded-lg">
          <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">
            No one is currently assigned the intermediate approval permission. The Project Request cannot be
            submitted for approval. Contact an administrator.
          </p>
        </div>
      ) : (
        <ProjectRequestForm
          departments={departments}
          types={activeTypes}
          defaultDepartmentId={defaultDepartmentId}
          intermediateApproverOptions={intermediateApproverOptions}
        />
      )}
    </div>
  );
}
