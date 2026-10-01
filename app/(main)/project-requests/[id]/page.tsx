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
import { formatEUR } from "@/lib/currency";

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
    },
  });
  if (!request) notFound();

  // Visibility: requester, or effective projectRequest.approve for THIS
  // request's own department — never a broader shortcut. A user outside
  // both sees a plain 404, never a distinguishable "exists but forbidden"
  // response, so a forged URL can't be used to probe for a request's
  // existence.
  const canView = await canViewProjectRequest(session.user.id, session.user.role, session.user.customRoleId, request);
  if (!canView) notFound();

  const canDecideNow =
    request.status === "PENDING_APPROVAL" &&
    (await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, request.departmentId, "projectRequest.approve"));

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
            {request.projectType.name} · {request.department.name}
          </p>
        </div>
        <ProjectRequestStatusBadge status={request.status} />
      </div>

      <div className="rounded-lg border divide-y">
        <Field label="Description" value={request.description} multiline />
        <Field label="Importance level" value={PROJECT_PRIORITY_LABEL[request.importance] ?? String(request.importance)} />
        {/* The SNAPSHOT taken at submission time — never a live read of
            request.projectType.cost, which may have since been edited by an
            admin. See POST /api/project-requests for where this is frozen. */}
        <Field label="Cost" value={formatEUR(request.cost ? Number(request.cost) : null) ?? "Not set"} />
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
          <h2 className="text-sm font-semibold mb-2">Approval</h2>
          <ApprovalActions
            requestId={request.id}
            status={request.status}
            canDecideNow={canDecideNow}
            approver={request.approver}
            approvedAt={request.approvedAt}
            rejectedAt={request.rejectedAt}
            businessAssessment={request.businessAssessment}
          />
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
