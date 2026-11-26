import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { resolveIntermediateApproverCandidates } from "@/lib/services/project-request-service";
import { canSkipFinalApproval } from "@/lib/services/project-request-approver-eligibility-service";
import { ProjectRequestForm } from "@/components/project-requests/project-request-form";
import { FileText } from "lucide-react";

// Shown instead of any technical SQLGeneral/manager-chain detail (REQUIRED
// #6) — the underlying reason (API failure, unmatched/ambiguous identity,
// cycle, etc.) is still logged server-side via resolveIntermediateApproverCandidates's
// own caller, but never surfaced to the requester, who can't act on it
// anyway beyond signing out/in or contacting an administrator.
const SQLGENERAL_IDENTITY_UNAVAILABLE_MESSAGE =
  "Your organizational details are not yet available. Please sign out and sign in again. If the issue persists, contact your administrator.";

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

  // Skip-intermediate-approval permission (REQUIRED #2, #6): when held,
  // SQLGeneral verification is NOT required at all for this requester, so
  // resolveIntermediateApproverCandidates (the live SQLGeneral lookup) is
  // never even called — never showing the blocking "unresolved" warning,
  // and never spending a network round-trip on a check whose result would
  // be discarded anyway. A single accessible department is checked
  // precisely (global grant OR that department's own grant, the exact
  // union the submission route itself re-checks); the rare ambiguous
  // multi-department case (global-scope roles only) checks the GLOBAL
  // grant only — the submission route is always the real, authoritative,
  // per-submission check (REQUIRED #4) regardless of what this page shows.
  // Intermediate Approval can be skipped by every requester (explicit
  // opt-out in the form), so the manager chain is resolved only to OFFER the
  // normal path; an unresolved chain no longer blocks the page — the
  // requester can opt out instead (the server re-checks on submit).
  const candidateResolution = await resolveIntermediateApproverCandidates(session.user.id);
  // Departments (of the ones offered) where this user EFFECTIVELY holds
  // projectRequest.skipFinalApproval — a UI hint only; the checkbox is shown
  // just for these and re-evaluated whenever the selected department
  // changes. POST /api/project-requests re-checks it authoritatively.
  const skipFinalDepartmentIds = (
    await Promise.all(departments.map(async (d) => ((await canSkipFinalApproval(session.user.id, session.user.role, session.user.customRoleId, d.id)) ? d.id : null)))
  ).filter((id): id is string => id !== null);

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Project Request Form</h1>
        <p className="text-muted-foreground mt-1">
          Submit a request for a new Project. By default it is intermediate-approved by your verified manager and then
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
      ) : (
        <ProjectRequestForm
          departments={departments}
          defaultDepartmentId={defaultDepartmentId}
          intermediateApproverOptions={candidateResolution.status === "has_candidates" ? candidateResolution.candidates : []}
          managerStatus={candidateResolution.status}
          managerUnavailableMessage={candidateResolution.status === "unresolved" ? SQLGENERAL_IDENTITY_UNAVAILABLE_MESSAGE : undefined}
          skipFinalDepartmentIds={skipFinalDepartmentIds}
        />
      )}
    </div>
  );
}
