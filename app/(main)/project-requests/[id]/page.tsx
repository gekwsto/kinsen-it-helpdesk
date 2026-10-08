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
      approver: { select: { id: true, name: true, email: true } },
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

  const canDecideNow =
    request.status === "PENDING_APPROVAL" &&
    (await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, request.departmentId, "projectRequest.approve"));

  // THIS viewer's own intermediate-approver row, only if the requester
  // explicitly selected them for THIS request — never derived any other way.
  const myIntermediateRow = request.intermediateApprovers.find((r) => r.approver.id === session.user.id) ?? null;

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
        <Field label="Description" value={request.description} multiline />
        <Field label="Importance level" value={PROJECT_PRIORITY_LABEL[request.importance] ?? String(request.importance)} />
        <Field label="Team concerned" value={request.teamConcerned} />
        <Field label="Expected benefits" value={request.expectedBenefits} multiline />
        <Field label="Replaces an existing solution/project" value={request.replacesExisting ? "Yes" : "No"} />
        {request.replacesExisting && request.replacementDescription && (
          <Field label="Solution/project to be replaced" value={request.replacementDescription} multiline />
        )}
        <Field label="Requester" value={request.requester.name ?? request.requester.email} />
        <Field label="Submitted" value={request.submittedAt.toLocaleString()} />
        {request.legacyRequesterBusinessAssessment && (
          <Field label="Legacy requester business assessment" value={request.legacyRequesterBusinessAssessment} multiline />
        )}
      </div>

      <div className="rounded-lg border">
        <div className="px-4 py-3">
          <h2 className="text-sm font-semibold mb-2">Intermediate Approval</h2>
          <p className="text-xs text-muted-foreground mb-2">Every selected approver below must approve — any one rejecting ends the request.</p>
          <IntermediateApprovalActions requestId={request.id} approvers={request.intermediateApprovers} myRow={myIntermediateRow} />
        </div>
      </div>

      <div className="rounded-lg border">
        <div className="px-4 py-3">
          <h2 className="text-sm font-semibold mb-2">Final Approval</h2>
          {request.status === "PENDING_INTERMEDIATE_APPROVAL" ? (
            <p className="text-sm text-muted-foreground">Waiting for intermediate approval before final approval can begin.</p>
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
              viewerIsRecordedApprover={request.approver?.id === session.user.id}
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
