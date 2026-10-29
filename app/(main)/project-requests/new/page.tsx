import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { resolveIntermediateApproverCandidates } from "@/lib/services/project-request-service";
import { ProjectRequestForm } from "@/components/project-requests/project-request-form";
import { FileText, AlertTriangle } from "lucide-react";

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

  // The requester's OWN verified SQLGeneral direct manager — never
  // Company/Department, never a permission-holder pool. Three outcomes:
  //   - "has_candidates": show the (usually single) verified manager for
  //     explicit selection, exactly like the prior picker, just restricted.
  //   - "no_manager": a VERIFIED fact about this requester's own SQLGeneral
  //     record — the form renders with zero intermediate-approver UI, and
  //     submits straight to Final Approval.
  //   - "unresolved": anything short of a verified fact either way (API
  //     failure, unmatched/ambiguous identity, no TicketApp account,
  //     inactive account) — submission is blocked entirely. Never treated
  //     as "no manager".
  const candidateResolution = await resolveIntermediateApproverCandidates(session.user.id);

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Project Request Form</h1>
        <p className="text-muted-foreground mt-1">
          Submit a request for a new Project — your verified SQLGeneral manager must intermediate-approve it before
          it goes to final approval.
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
      ) : candidateResolution.status === "unresolved" ? (
        <div className="text-center py-20 border rounded-lg">
          <AlertTriangle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">
            {candidateResolution.reason} A Project Request cannot be submitted until this can be verified.
          </p>
        </div>
      ) : (
        <ProjectRequestForm
          departments={departments}
          defaultDepartmentId={defaultDepartmentId}
          intermediateApproverOptions={candidateResolution.status === "has_candidates" ? candidateResolution.candidates : []}
        />
      )}
    </div>
  );
}
