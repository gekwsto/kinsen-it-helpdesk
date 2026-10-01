"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Check, X } from "lucide-react";
import type { IntermediateApprovalStatus } from "@prisma/client";
import { ProjectRequestDecisionDialog } from "@/components/project-requests/project-request-decision-dialog";

export interface IntermediateApproverRow {
  id: string;
  status: IntermediateApprovalStatus;
  decidedAt: Date | null;
  businessAssessment: string | null;
  approver: { id: string; name: string | null; email: string };
}

interface IntermediateApprovalActionsProps {
  requestId: string;
  approvers: IntermediateApproverRow[];
  /** THIS viewer's own row, only if they are one of the selected approvers — never derived from anything but a real ProjectRequestIntermediateApprover row for this exact request. */
  myRow: IntermediateApproverRow | null;
}

/**
 * The intermediate stage's own panel — lists EVERY selected approver and
 * their individual decision (unanimous: all must APPROVE, any one REJECT
 * ends the request immediately), and offers Approve/Reject ONLY to the
 * viewer's own still-PENDING row, reusing the SAME shared
 * ProjectRequestDecisionDialog the final stage uses (with
 * assessmentRequired={false} — unlike the final stage, this stage never
 * asks for a written justification, confirmed with the user) — never a
 * second/duplicated decision modal. The API independently re-checks both
 * "do you hold projectRequest.intermediateApprove" and "are you genuinely
 * selected for this request" on every submit, regardless of what this
 * component shows.
 */
export function IntermediateApprovalActions({ requestId, approvers, myRow }: IntermediateApprovalActionsProps) {
  const router = useRouter();
  const [pendingDecision, setPendingDecision] = useState<"approve" | "reject" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const submit = async ({ businessAssessment: assessment }: { businessAssessment: string; projectOwnerId?: string }) => {
    if (!pendingDecision) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const res = await fetch(`/api/project-requests/${requestId}/intermediate-approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: pendingDecision, businessAssessment: assessment || undefined }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message ?? err.error ?? "Failed to submit decision");
      }
      toast.success(pendingDecision === "approve" ? "Intermediate approval recorded" : "Request rejected");
      setPendingDecision(null);
      router.refresh();
    } catch (error: any) {
      const message = error.message ?? "Failed to submit decision";
      setServerError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = () => {
    setPendingDecision(null);
    setServerError(null);
  };

  return (
    <div className="space-y-3">
      <div className="divide-y rounded-md border">
        {approvers.map((row) => (
          <div key={row.id} className="px-3 py-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{row.approver.name ?? row.approver.email}</span>
              <span
                className={
                  row.status === "APPROVED"
                    ? "text-xs font-medium text-green-700"
                    : row.status === "REJECTED"
                    ? "text-xs font-medium text-red-700"
                    : "text-xs font-medium text-muted-foreground"
                }
              >
                {row.status === "APPROVED" ? "Approved" : row.status === "REJECTED" ? "Rejected" : "Pending"}
              </span>
            </div>
            {row.decidedAt && <p className="text-xs text-muted-foreground mt-0.5">{row.decidedAt.toLocaleString()}</p>}
            {row.businessAssessment && <p className="text-sm whitespace-pre-wrap mt-1">{row.businessAssessment}</p>}
          </div>
        ))}
      </div>

      {myRow && myRow.status === "PENDING" && (
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
          <ProjectRequestDecisionDialog
            decision={pendingDecision}
            submitting={submitting}
            serverError={serverError}
            onCancel={cancel}
            onConfirm={submit}
            assessmentRequired={false}
          />
        </>
      )}
    </div>
  );
}
