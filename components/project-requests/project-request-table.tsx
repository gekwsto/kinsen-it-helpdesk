"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Check, FileText, X, Eye, FolderKanban } from "lucide-react";
import { ProjectRequestStatusBadge } from "@/components/project-requests/project-request-status-badge";
import { ProjectRequestDecisionDialog, type ProjectOwnerOption } from "@/components/project-requests/project-request-decision-dialog";
import { PROJECT_PRIORITY_LABEL } from "@/lib/project-priority";
import { formatDateTime } from "@/lib/utils";
import { formatEUR } from "@/lib/currency";
import type { ProjectRequestStatus, IntermediateApprovalStatus } from "@prisma/client";

export interface ProjectRequestRow {
  id: string;
  title: string;
  status: ProjectRequestStatus;
  description: string;
  importance: number;
  /** A SNAPSHOT taken at submission time — never a live read of the type's own (possibly since-edited) cost. */
  cost: number | null;
  teamConcerned: string;
  expectedBenefits: string;
  replacesExisting: boolean;
  replacementDescription: string | null;
  projectType: { id: string; name: string };
  department: { id: string; name: string };
  requester: { name: string | null; email: string };
  submittedAt: Date;
  approver: { name: string | null; email: string } | null;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  businessAssessment: string | null;
  legacyRequesterBusinessAssessment: string | null;
  /** Every requester-selected intermediate approver for this request and their individual decision — read-only informational display in Preview; the actual decision UI lives on the detail page. */
  intermediateApprovers: { id: string; status: IntermediateApprovalStatus; approver: { name: string | null; email: string } }[];
  /** The Project auto-created from this request once it was approved (see decideApproval) — null until then. */
  project: { id: string; title: string } | null;
  /**
   * Server-computed (status === PENDING_APPROVAL AND effective
   * projectRequest.approve for THIS row's own department — the same
   * scope resolveApprovalScope/buildAwaitingMyApprovalWhere already use) —
   * a UI convenience only; the API independently re-checks this on every
   * submit. Computed ONCE per page load from a single scope lookup, never
   * a per-row permission query (no N+1).
   */
  canDecideNow: boolean;
}

interface ProjectRequestTableProps {
  requests: ProjectRequestRow[];
  emptyMessage: string;
  /** Every active, project-assignable user for each department represented among `requests` — keyed by departmentId. Pre-fetched once per page load (never a per-row/on-open fetch — the SAME no-N+1 convention this table's own Approve/Reject already follows) so the owner picker has real data the instant a row's Approve dialog opens. */
  assignableOwnersByDepartment: Record<string, ProjectOwnerOption[]>;
}

type Decision = "approve" | "reject";

/**
 * Inline Preview/Approve/Reject for the Project Requests list — same UX
 * pattern as components/tickets/pending-ticket-table.tsx: all row data is
 * already loaded by the server page (no per-row fetch), Preview is a local-
 * state dialog over the already-loaded row, and Approve/Reject reuse the
 * SAME shared ProjectRequestDecisionDialog and the SAME
 * POST /api/project-requests/[id]/approval endpoint the detail page's
 * ApprovalActions uses — never a second/duplicated approval modal or a
 * second copy of the decision logic.
 */
export function ProjectRequestTable({ requests, emptyMessage, assignableOwnersByDepartment }: ProjectRequestTableProps) {
  const router = useRouter();

  const [previewTarget, setPreviewTarget] = useState<ProjectRequestRow | null>(null);
  const [decisionTarget, setDecisionTarget] = useState<{ row: ProjectRequestRow; decision: Decision } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Opening a decision FROM the preview modal closes the preview first —
  // only one dialog is ever open at a time, which structurally avoids the
  // "preview still shows stale data after a decision" problem rather than
  // trying to reconcile two open dialogs.
  const openDecision = (row: ProjectRequestRow, decision: Decision) => {
    setPreviewTarget(null);
    setServerError(null);
    setDecisionTarget({ row, decision });
  };

  const cancelDecision = () => {
    setDecisionTarget(null);
    setServerError(null);
  };

  const submitDecision = async ({ businessAssessment, projectOwnerId }: { businessAssessment: string; projectOwnerId?: string }) => {
    if (!decisionTarget) return;
    const { row, decision } = decisionTarget;
    setSubmitting(true);
    setServerError(null);
    try {
      const res = await fetch(`/api/project-requests/${row.id}/approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, businessAssessment, projectOwnerId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 409) {
          // Someone else already decided this row (or it moved under us) —
          // there is nothing useful to retry. Close cleanly, refresh to the
          // authoritative state, and say so — never leave a dialog open on
          // a request that can only ever fail again, and never imply the
          // action actually succeeded.
          toast.error("This request was already decided by someone else — refreshing.");
          setDecisionTarget(null);
          router.refresh();
          return;
        }
        throw new Error(err.message ?? err.error ?? "Failed to submit decision");
      }
      toast.success(decision === "approve" ? "Request approved" : "Request rejected");
      setDecisionTarget(null);
      router.refresh();
    } catch (error: any) {
      const message = error.message ?? "Failed to submit decision";
      setServerError(message);
      toast.error(message);
      // Dialog deliberately stays open (decisionTarget untouched) so the
      // typed assessment is never lost on a failed submit.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>Requester</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Submitted</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7}>
                  <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground">
                    <FileText className="h-8 w-8" />
                    <p className="text-sm">{emptyMessage}</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              requests.map((r) => {
                const rowBusy = submitting && decisionTarget?.row.id === r.id;
                return (
                  <TableRow key={r.id}>
                    <TableCell className="max-w-[280px]">
                      <button
                        type="button"
                        onClick={() => setPreviewTarget(r)}
                        className="text-sm font-medium truncate hover:text-primary hover:underline text-left block w-full"
                        title="Preview this request"
                      >
                        {r.title}
                      </button>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{r.projectType.name}</TableCell>
                    <TableCell className="text-muted-foreground">{r.department.name}</TableCell>
                    <TableCell className="text-muted-foreground">{r.requester.name ?? r.requester.email}</TableCell>
                    <TableCell>
                      <ProjectRequestStatusBadge status={r.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">{r.submittedAt.toLocaleDateString()}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" variant="ghost" onClick={() => setPreviewTarget(r)} title="Preview this request">
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                        {r.canDecideNow && (
                          <>
                            <Button size="sm" variant="outline" disabled={rowBusy} onClick={() => openDecision(r, "approve")}>
                              <Check className="h-3.5 w-3.5 mr-1.5 text-emerald-600" />
                              Approve
                            </Button>
                            <Button size="sm" variant="outline" disabled={rowBusy} onClick={() => openDecision(r, "reject")}>
                              <X className="h-3.5 w-3.5 mr-1.5 text-destructive" />
                              Reject
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Preview dialog — read-only project request detail, loaded from the
          SAME row data the list already fetched (no per-row/N+1 request).
          Escaped text throughout (plain React text nodes, never
          dangerouslySetInnerHTML); whitespace-pre-wrap on the large text
          fields; scrollable body for long content. */}
      <Dialog open={!!previewTarget} onOpenChange={(o) => !o && setPreviewTarget(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="pr-6 break-words">{previewTarget?.title}</DialogTitle>
          </DialogHeader>
          {previewTarget && (
            <div className="flex-1 min-h-0 flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm border rounded-md p-3 bg-muted/30 flex-shrink-0">
                <div>
                  <span className="text-muted-foreground">Type: </span>
                  <span className="font-medium">{previewTarget.projectType.name}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Status: </span>
                  <ProjectRequestStatusBadge status={previewTarget.status} />
                </div>
                <div>
                  <span className="text-muted-foreground">Department: </span>
                  <span className="font-medium">{previewTarget.department.name}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Submitted: </span>
                  <span className="font-medium">{formatDateTime(previewTarget.submittedAt)}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Requester: </span>
                  <span className="font-medium">{previewTarget.requester.name ?? previewTarget.requester.email}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Importance: </span>
                  <span className="font-medium">{PROJECT_PRIORITY_LABEL[previewTarget.importance] ?? String(previewTarget.importance)}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Cost: </span>
                  <span className="font-medium">{formatEUR(previewTarget.cost) ?? "Not set"}</span>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto rounded-md border divide-y">
                <PreviewField label="Description" value={previewTarget.description} multiline />
                <PreviewField label="Team concerned" value={previewTarget.teamConcerned} />
                <PreviewField label="Expected benefits" value={previewTarget.expectedBenefits} multiline />
                <PreviewField label="Replaces an existing solution/project" value={previewTarget.replacesExisting ? "Yes" : "No"} />
                {previewTarget.replacesExisting && previewTarget.replacementDescription && (
                  <PreviewField label="Solution/project to be replaced" value={previewTarget.replacementDescription} multiline />
                )}
                {previewTarget.intermediateApprovers.length > 0 && (
                  <div className="px-4 py-3">
                    <p className="text-xs font-medium text-muted-foreground mb-1.5">Intermediate Approval</p>
                    <div className="space-y-1">
                      {previewTarget.intermediateApprovers.map((row) => (
                        <div key={row.id} className="flex items-center justify-between text-sm">
                          <span>{row.approver.name ?? row.approver.email}</span>
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
                      ))}
                    </div>
                  </div>
                )}
                {previewTarget.approver && (
                  <div className="px-4 py-3">
                    <p className="text-xs font-medium text-muted-foreground mb-1">
                      {previewTarget.status === "APPROVED" ? "Approved by" : "Rejected by"}
                    </p>
                    <p className="text-sm">{previewTarget.approver.name ?? previewTarget.approver.email}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatDateTime((previewTarget.approvedAt ?? previewTarget.rejectedAt) as Date)}
                    </p>
                    {previewTarget.businessAssessment && (
                      <p className="text-sm whitespace-pre-wrap mt-2">{previewTarget.businessAssessment}</p>
                    )}
                    {previewTarget.project && (
                      <Link
                        href={`/projects/${previewTarget.project.id}`}
                        className="inline-flex items-center gap-1.5 mt-2 text-sm text-primary hover:underline"
                      >
                        <FolderKanban className="h-3.5 w-3.5" />
                        View Project
                      </Link>
                    )}
                  </div>
                )}
                {previewTarget.legacyRequesterBusinessAssessment && (
                  <PreviewField label="Legacy requester business assessment" value={previewTarget.legacyRequesterBusinessAssessment} multiline />
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewTarget(null)}>
              Close
            </Button>
            {previewTarget?.canDecideNow && (
              <>
                <Button variant="outline" onClick={() => openDecision(previewTarget, "reject")}>
                  <X className="h-3.5 w-3.5 mr-1.5 text-destructive" />
                  Reject
                </Button>
                <Button onClick={() => openDecision(previewTarget, "approve")}>
                  <Check className="h-3.5 w-3.5 mr-1.5" />
                  Approve
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* The ONE shared decision modal — reused verbatim from the detail
          page's ApprovalActions, never a second/independent implementation. */}
      <ProjectRequestDecisionDialog
        decision={decisionTarget?.decision ?? null}
        submitting={submitting}
        serverError={serverError}
        onCancel={cancelDecision}
        onConfirm={submitDecision}
        ownerOptions={decisionTarget ? assignableOwnersByDepartment[decisionTarget.row.department.id] ?? [] : undefined}
      />
    </div>
  );
}

function PreviewField({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  return (
    <div className="px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground mb-1">{label}</p>
      <p className={multiline ? "text-sm whitespace-pre-wrap" : "text-sm"}>{value}</p>
    </div>
  );
}
