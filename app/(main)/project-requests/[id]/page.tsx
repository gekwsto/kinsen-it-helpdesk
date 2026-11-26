import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { canViewProjectRequest } from "@/lib/services/project-request-service";
import { hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import { PROJECT_PRIORITY_LABEL } from "@/lib/project-priority";
import { ProjectRequestStatusBadge } from "@/components/project-requests/project-request-status-badge";
import { ApprovalActions } from "@/components/project-requests/approval-actions";
import { IntermediateApprovalActions } from "@/components/project-requests/intermediate-approval-actions";
import { SkippedIntermediateStage } from "@/components/project-requests/skipped-stage";

export default async function ProjectRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const { id } = await params;

  const request = await prisma.projectRequest.findUnique({
    where: { id },
    include: {
      projectType: { select: { id: true, name: true } },
      department: { select: { id: true, name: true } },
      requester: { select: { id: true, name: true, email: true } },
      requesterDepartment: { select: { id: true, name: true } },
      approver: { select: { id: true, name: true, email: true } },
      finalApprovalSkippedBy: { select: { id: true, name: true, email: true } },
      intermediateApprovers: {
        include: { approver: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: "asc" },
      },
      project: { select: { id: true, title: true } },
    },
  });
  if (!request) notFound();

  // Visibility: requester, within effective FINAL approval scope for THIS
  // request's own department, or one of THIS request's own selected
  // intermediate approvers — never a broader shortcut. A user outside all
  // three sees a plain 404, never a distinguishable "exists but forbidden"
  // response, so a forged URL can't be used to probe for a request's
  // existence.
  const canView = await canViewProjectRequest(session.user.id, session.user.role, session.user.customRoleId, request);
  if (!canView) notFound();

  // Shared by both canDecideNow (gated to PENDING_APPROVAL) and the
  // Project-setup completion button below (gated to APPROVED + no Project
  // yet instead) — the same underlying authority, "may finalize this
  // department's requests right now," just applied at two different stages
  // of the same request's lifecycle. One permission lookup either way.
  const hasApprovePermission = await hasEffectiveEntityPermission(
    session.user.id,
    session.user.role,
    session.user.customRoleId,
    request.departmentId,
    "projectRequest.approve"
  );
  const canDecideNow = request.status === "PENDING_APPROVAL" && hasApprovePermission;

  // THIS viewer's own intermediate-approver row, only if the requester
  // explicitly selected them for THIS request — never derived any other way.
  const myIntermediateRow = request.intermediateApprovers.find((r) => r.approver.id === session.user.id) ?? null;
  // The persisted intermediate decision that rejected this request (if it was
  // rejected during Intermediate Approval — there is then no final approver).
  const intermediateRejectionRow = request.intermediateApprovers.find((r) => r.status === "REJECTED") ?? null;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Link href="/project-requests" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
          Project Requests
        </Link>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{request.title}</h1>
          <p className="text-muted-foreground mt-1">
            {/* projectType (the former "Project Type" on a Project Request)
                is historical only — a request submitted before that
                classification moved to Activity still shows its original
                type; a NEW request never has one. */}
            {request.projectType ? `${request.projectType.name} · ` : ""}
            {request.department.name}
          </p>
        </div>
        <ProjectRequestStatusBadge status={request.status} />
      </div>

      <div className="rounded-lg border divide-y">
        {/* Phase 4.1 — description/importance/teamConcerned/expectedBenefits
            are null ONLY for a HISTORICAL_IMPORT request whose source data
            genuinely has no value for them (no column at all, in the real
            first import batch) — a STANDARD request always has real
            values, enforced at the application boundary. Never guessed;
            renders as "Not recorded". */}
        <Field label="Description" value={request.description ?? "Not recorded"} multiline />
        <Field
          label="Importance level"
          value={request.importance != null ? PROJECT_PRIORITY_LABEL[request.importance] ?? String(request.importance) : "Not recorded"}
        />
        <Field label="Team concerned" value={request.teamConcerned ?? "Not recorded"} />
        <Field label="Expected benefits" value={request.expectedBenefits ?? "Not recorded"} multiline />
        <Field label="Replaces an existing solution/project" value={request.replacesExisting ? "Yes" : "No"} />
        {request.replacesExisting && request.replacementDescription && (
          <Field label="Solution/project to be replaced" value={request.replacementDescription} multiline />
        )}
        {/* Source — always shown, so "Standard" vs. "Historical Import" is
            never ambiguous from absence alone (see this feature's own
            "do not display misleading approval badges" requirement —
            applies just as much to leaving the source itself unstated). */}
        <Field label="Source" value={request.source === "HISTORICAL_IMPORT" ? "Historical Import" : "Standard"} />
        {/* Null (rendered "Not recorded") ONLY for a HISTORICAL_IMPORT
            request whose original requester genuinely isn't known from the
            source data — never guessed/fabricated. */}
        <Field label="Requester" value={request.requester ? request.requester.name ?? request.requester.email : "Not recorded"} />
        {/* Read-only snapshot of the requester's OWN department at
            submission time — never the request's target department
            (above) and never editable here. "Not recorded" for a request
            created before this field existed, whose requester had no
            primary department at the time, or a HISTORICAL_IMPORT request
            whose source data didn't record one — never guessed from their
            CURRENT membership. */}
        <Field label="Requester Department" value={request.requesterDepartment?.name ?? "Not recorded"} />
        <Field label="Submitted" value={request.submittedAt ? request.submittedAt.toLocaleString() : "Not recorded"} />
        {request.legacyRequesterBusinessAssessment && (
          <Field label="Legacy requester business assessment" value={request.legacyRequesterBusinessAssessment} multiline />
        )}
        {/* Phase 4.1 — read-only, Historical Import only. Opaque source
            fields preserved with no canonical destination elsewhere (see
            ProjectRequest.historicalSourceMetadata's own doc comment) —
            plain key/value text, never interpreted/executed. Ticket ID and
            Zoho Link are never stored here (out of scope for import) so
            they never appear in this block. */}
        {request.source === "HISTORICAL_IMPORT" && request.historicalSourceMetadata != null && (
          <HistoricalSourceMetadataFields metadata={request.historicalSourceMetadata as Record<string, unknown>} />
        )}
      </div>

      <div className="rounded-lg border">
        <div className="px-4 py-3">
          <h2 className="text-sm font-semibold mb-2">Intermediate Approval</h2>
          {request.intermediateApprovalSkipReason ? (
            <SkippedIntermediateStage reason={request.intermediateApprovalSkipReason} />
          ) : (
            <>
              <p className="text-xs text-muted-foreground mb-2">Every selected approver below must approve — any one rejecting ends the request.</p>
              <IntermediateApprovalActions requestId={request.id} approvers={request.intermediateApprovers} myRow={myIntermediateRow} />
            </>
          )}
        </div>
      </div>

      <div className="rounded-lg border">
        <div className="px-4 py-3">
          <h2 className="text-sm font-semibold mb-2">Final Approval</h2>
          {request.status === "PENDING_INTERMEDIATE_APPROVAL" && !request.finalApprovalSkipped ? (
            <p className="text-sm text-muted-foreground">Waiting for intermediate approval before final approval can begin.</p>
          ) : request.status === "REJECTED" && !request.approver && intermediateRejectionRow ? (
            // Rejected during INTERMEDIATE approval — the final stage was
            // never reached; the rejecting user/time/comment are shown in the
            // Intermediate Approval section above (their persisted decision).
            <p className="text-sm text-muted-foreground" data-testid="final-not-reached">
              Not reached — rejected during Intermediate Approval by{" "}
              <span className="font-medium text-foreground">{intermediateRejectionRow.approver.name ?? intermediateRejectionRow.approver.email}</span>
              {intermediateRejectionRow.decidedAt ? ` on ${intermediateRejectionRow.decidedAt.toLocaleString()}` : ""}.
            </p>
          ) : (
            <ApprovalActions
              requestId={request.id}
              status={request.status}
              canDecideNow={canDecideNow}
              approver={request.approver}
              approvedAt={request.approvedAt}
              rejectedAt={request.rejectedAt}
              businessAssessment={request.businessAssessment}
              project={request.project}
              canCompleteSetup={hasApprovePermission}
              finalApprovalSkipped={request.finalApprovalSkipped}
              finalApprovalSkippedBy={request.finalApprovalSkippedBy}
              finalApprovalSkippedAt={request.finalApprovalSkippedAt}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  return (
    <div className="px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground mb-1">{label}</p>
      <p className={multiline ? "text-sm whitespace-pre-wrap" : "text-sm"}>{value}</p>
    </div>
  );
}

// Phase 4.1 — labels every key this app's own HistoricalSourceMetadata
// shape (lib/services/project-request-historical-import-service.ts) can
// ever contain; any other key is shown with its own raw name rather than
// silently dropped, so nothing persisted is ever invisible here.
const HISTORICAL_SOURCE_METADATA_LABELS: Record<string, string> = {
  feedbackUsers: "Feedback user(s) (source)",
  originalEstimatedCost: "Original estimated cost (source)",
  originalActualCost: "Original actual cost (source)",
  originalTotalDays: "Original \"Total Days\" (source, unverified mapping)",
};

function HistoricalSourceMetadataFields({ metadata }: { metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata).filter(([, v]) => v !== null && v !== undefined);
  if (entries.length === 0) return null;
  return (
    <div className="px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground mb-1.5">Preserved historical source data (unmapped)</p>
      <div className="space-y-1">
        {entries.map(([key, value]) => (
          <p key={key} className="text-sm">
            <span className="text-muted-foreground">{HISTORICAL_SOURCE_METADATA_LABELS[key] ?? key}: </span>
            {String(value)}
          </p>
        ))}
      </div>
    </div>
  );
}
