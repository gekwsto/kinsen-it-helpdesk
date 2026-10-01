"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Loader2, Check, X } from "lucide-react";
import type { ProjectRequestStatus } from "@prisma/client";
import { ProjectRequestDecisionDialog } from "@/components/project-requests/project-request-decision-dialog";

interface ApprovalActionsProps {
  requestId: string;
  status: ProjectRequestStatus;
  /** Server-computed (hasEffectiveEntityPermission for THIS request's own department) — a UI convenience only; the API independently re-checks this on every submit. */
  canDecideNow: boolean;
  approver: { id: string; name: string | null; email: string } | null;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  /** The approver's OWN mandatory justification for the decision — written only at decision time, never the requester's text (see legacyRequesterBusinessAssessment on the detail page for that). */
  businessAssessment: string | null;
}

/**
 * Approve/Reject — clicking never mutates anything by itself; it only opens
 * the shared ProjectRequestDecisionDialog, which requires a Business
 * Assessment and performs the actual API call on confirm. Only offered
 * while status === PENDING_APPROVAL AND the viewer holds effective
 * projectRequest.approve for this request's department; once APPROVED or
 * REJECTED it renders as a read-only decision summary with the approver's
 * name, decision timestamp, and their Business Assessment — a one-way
 * completion, never re-editable from here, and never an uncheck/rollback
 * path. Any user who holds effective projectRequest.approve for this
 * request's department may act — never tied to the requester's own
 * manager/org-chart in any way.
 */
export function ApprovalActions({ requestId, status, canDecideNow, approver, approvedAt, rejectedAt, businessAssessment }: ApprovalActionsProps) {
  const router = useRouter();
  const [pendingDecision, setPendingDecision] = useState<"approve" | "reject" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const submit = async (assessment: string) => {
    if (!pendingDecision) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const res = await fetch(`/api/project-requests/${requestId}/approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: pendingDecision, businessAssessment: assessment }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message ?? err.error ?? "Failed to submit decision");
      }
      toast.success(pendingDecision === "approve" ? "Request approved" : "Request rejected");
      setPendingDecision(null);
      router.refresh();
    } catch (error: any) {
      const message = error.message ?? "Failed to submit decision";
      setServerError(message);
      toast.error(message);
      // Dialog deliberately stays open (pendingDecision untouched) so the
      // typed assessment is never lost on a failed submit.
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = () => {
    setPendingDecision(null);
    setServerError(null);
  };

  if (status === "APPROVED" && approver) {
    return (
      <div className="text-sm">
        <p className="text-green-700">
          Approved by <span className="font-medium">{approver.name ?? approver.email}</span>
        </p>
        {approvedAt && <p className="text-muted-foreground">{approvedAt.toLocaleString()}</p>}
        {businessAssessment && <p className="whitespace-pre-wrap mt-1">{businessAssessment}</p>}
      </div>
    );
  }

  if (status === "REJECTED" && approver) {
    return (
      <div className="text-sm">
        <p className="text-red-700">
          Rejected by <span className="font-medium">{approver.name ?? approver.email}</span>
        </p>
        {rejectedAt && <p className="text-muted-foreground">{rejectedAt.toLocaleString()}</p>}
        {businessAssessment && <p className="whitespace-pre-wrap mt-1">{businessAssessment}</p>}
      </div>
    );
  }

  if (!canDecideNow) {
    return <p className="text-sm text-muted-foreground">Awaiting approval from someone in this department with approval rights.</p>;
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => setPendingDecision("approve")}>
          <Check className="h-4 w-4 mr-1.5" />
          Approve
        </Button>
        <Button size="sm" variant="outline" onClick={() => setPendingDecision("reject")}>
          <X className="h-4 w-4 mr-1.5" />
          Reject
        </Button>
      </div>

      <ProjectRequestDecisionDialog decision={pendingDecision} submitting={submitting} serverError={serverError} onCancel={cancel} onConfirm={submit} />
    </>
  );
}
