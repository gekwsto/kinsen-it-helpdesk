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
import { Check, FileText, X, Eye, FolderKanban, Wrench } from "lucide-react";
import { ProjectRequestStatusBadge } from "@/components/project-requests/project-request-status-badge";
import { ProjectRequestDecisionDialog } from "@/components/project-requests/project-request-decision-dialog";
import { SkippedIntermediateStage, SkippedFinalStage, type IntermediateSkipReason } from "@/components/project-requests/skipped-stage";
import { PreviewField } from "@/components/shared/preview-field";
import { PROJECT_PRIORITY_LABEL } from "@/lib/project-priority";
import { formatDate, formatDateTime } from "@/lib/utils";
import type { ProjectRequestStatus, IntermediateApprovalStatus, ProjectRequestSource } from "@prisma/client";

export interface ProjectRequestRow {
  id: string;
  title: string;
  status: ProjectRequestStatus;
  // Phase 4.1 — null ONLY for a HISTORICAL_IMPORT request whose source
  // data genuinely has none (no column at all, in the real first import
  // batch) — a STANDARD request always has real values, enforced at the
  // application boundary. Never guessed/fabricated; renders as "Not
  // recorded".
  description: string | null;
  importance: number | null;
  teamConcerned: string | null;
  expectedBenefits: string | null;
  replacesExisting: boolean;
  replacementDescription: string | null;
  // Historical only (the former "Project Type" on a Project Request) — a
  // NEW request never has one, since that classification moved to
  // Activity. Null for every request submitted after that change.
  projectType: { id: string; name: string } | null;
  department: { id: string; name: string };
  // Phase 3 — distinguishes a STANDARD request (always has a real
  // requester/submittedAt, same as before) from a HISTORICAL_IMPORT one,
  // which may not.
  source: ProjectRequestSource;
  // Null ONLY for a HISTORICAL_IMPORT request whose original requester
  // isn't known from the source data — never fabricated/guessed. Renders
  // as "Not recorded".
  requester: { name: string | null; email: string } | null;
  submittedAt: Date | null;
  approver: { name: string | null; email: string } | null;
  /** Skipped stages (set at submission) — shown as "Skipped", never as approvals. */
  intermediateApprovalSkipReason: IntermediateSkipReason | null;
  finalApprovalSkipped: boolean;
  finalApprovalSkippedBy: { name: string | null; email: string } | null;
  finalApprovalSkippedAt: Date | null;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  businessAssessment: string | null;
  legacyRequesterBusinessAssessment: string | null;
  /** Every requester-selected intermediate approver for this request and their individual decision — read-only informational display in Preview; the actual decision UI lives on the detail page. */
  intermediateApprovers: { id: string; status: IntermediateApprovalStatus; decidedAt: Date | null; businessAssessment: string | null; approver: { name: string | null; email: string } }[];
  /** The Project created from this request's own request-origin setup flow (see createProjectFromApprovedRequest) — null until that's been completed. */
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
  /**
   * Server-computed (status === APPROVED AND no Project yet AND effective
   * projectRequest.approve for THIS row's own department — the same scope
   * canDecideNow above uses, just applied at the Project-setup stage
   * instead of the decision stage). Anyone who currently holds that
   * authority may complete setup, not only whoever originally approved —
   * see createProjectFromApprovedRequest's own doc comment.
   */
  canCompleteSetup: boolean;
}

interface ProjectRequestTableProps {
  requests: ProjectRequestRow[];
  emptyMessage: string;
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
/** The persisted intermediate decision that rejected this request, if it was rejected during Intermediate Approval. */
function intermediateRejection(r: { intermediateApprovers: ProjectRequestRow["intermediateApprovers"] }) {
  return r.intermediateApprovers.find((row) => row.status === "REJECTED") ?? null;
}

export function ProjectRequestTable({ requests, emptyMessage }: ProjectRequestTableProps) {
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

  const submitDecision = async ({ businessAssessment }: { businessAssessment: string }) => {
    if (!decisionTarget) return;
    const { row, decision } = decisionTarget;
    setSubmitting(true);
    setServerError(null);
    try {
      const res = await fetch(`/api/project-requests/${row.id}/approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, businessAssessment }),
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
      if (decision === "approve") {
        toast.success("Request approved — let's set up the Project.");
        setDecisionTarget(null);
        // A full navigation, same as the detail page's own post-approve
        // redirect — Project setup is a dedicated page, not another modal
        // stacked on this list.
        router.push(`/projects/new?projectRequestId=${row.id}`);
        return;
      }
      toast.success("Request rejected");
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
                    <TableCell className="text-muted-foreground">{r.projectType?.name ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{r.department.name}</TableCell>
                    <TableCell className="text-muted-foreground">{r.requester ? r.requester.name ?? r.requester.email : "Not recorded"}</TableCell>
                    <TableCell>
                      {/* Phase 3.1: the status badge alone now already
                          visually distinguishes a Historical Import row
                          (its own "Imported" status/color, never
                          "Approved") — the separate source pill this used
                          to need (back when both shared the "Approved"
                          status/color) is no longer necessary and was
                          removed to avoid redundant clutter. Source itself
                          is still shown explicitly in the Preview dialog
                          below. */}
                      <ProjectRequestStatusBadge status={r.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">{r.submittedAt ? formatDate(r.submittedAt) : "Not recorded"}</TableCell>
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
                  <span className="font-medium">{previewTarget.projectType?.name ?? "—"}</span>
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
                  <span className="font-medium">{previewTarget.submittedAt ? formatDateTime(previewTarget.submittedAt) : "Not recorded"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Requester: </span>
                  <span className="font-medium">{previewTarget.requester ? previewTarget.requester.name ?? previewTarget.requester.email : "Not recorded"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Importance: </span>
                  <span className="font-medium">
                    {previewTarget.importance != null ? PROJECT_PRIORITY_LABEL[previewTarget.importance] ?? String(previewTarget.importance) : "Not recorded"}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Source: </span>
                  <span className="font-medium">{previewTarget.source === "HISTORICAL_IMPORT" ? "Historical Import" : "Standard"}</span>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto rounded-md border divide-y">
                <PreviewField label="Description" value={previewTarget.description ?? "Not recorded"} multiline />
                <PreviewField label="Team concerned" value={previewTarget.teamConcerned ?? "Not recorded"} />
                <PreviewField label="Expected benefits" value={previewTarget.expectedBenefits ?? "Not recorded"} multiline />
                <PreviewField label="Replaces an existing solution/project" value={previewTarget.replacesExisting ? "Yes" : "No"} />
                {previewTarget.replacesExisting && previewTarget.replacementDescription && (
                  <PreviewField label="Solution/project to be replaced" value={previewTarget.replacementDescription} multiline />
                )}
                {previewTarget.intermediateApprovalSkipReason && (
                  <div className="px-4 py-3">
                    <p className="text-xs font-medium text-muted-foreground mb-1">Intermediate Approval</p>
                    <SkippedIntermediateStage reason={previewTarget.intermediateApprovalSkipReason} />
                  </div>
                )}
                {previewTarget.finalApprovalSkipped && (
                  <div className="px-4 py-3">
                    <p className="text-xs font-medium text-muted-foreground mb-1">Final Approval</p>
                    <SkippedFinalStage skippedBy={previewTarget.finalApprovalSkippedBy} skippedAt={previewTarget.finalApprovalSkippedAt} />
                  </div>
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
                {/* Approver summary — only for an ACTUAL final decision (or an
                    import). A request whose Final Approval was skipped has no
                    final approver; its Project setup controls render below
                    the "Skipped" block instead. */}
                {previewTarget.finalApprovalSkipped && previewTarget.status === "APPROVED" && (
                  <div className="px-4 pb-3">
                    {previewTarget.project ? (
                      <Link href={`/projects/${previewTarget.project.id}`} className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
                        <FolderKanban className="h-3.5 w-3.5" />
                        View Project
                      </Link>
                    ) : previewTarget.canCompleteSetup ? (
                      <Button size="sm" asChild>
                        <Link href={`/projects/new?projectRequestId=${previewTarget.id}`}>
                          <Wrench className="h-3.5 w-3.5 mr-1.5" />
                          Complete Project Setup
                        </Link>
                      </Button>
                    ) : (
                      <p className="text-xs text-muted-foreground">Project setup is still pending, from someone with final-approval rights in this department.</p>
                    )}
                  </div>
                )}
                {!previewTarget.finalApprovalSkipped && (previewTarget.status === "APPROVED" || previewTarget.status === "REJECTED" || previewTarget.status === "IMPORTED") && (
                  <div className="px-4 py-3">
                    <p className="text-xs font-medium text-muted-foreground mb-1">
                      {previewTarget.status === "APPROVED" ? "Approved by" : previewTarget.status === "REJECTED" ? "Rejected by" : "Imported"}
                    </p>
                    {/* Historical Import (status IMPORTED, Phase 3.1) may
                        have a real, preserved approver/approvedAt from
                        source data, or none at all — both shown
                        explicitly, never fabricated. The Project
                        link/setup status below is deliberately OUTSIDE
                        this null-check, so it's never hidden just because
                        the approver is unknown. */}
                    {/* A request rejected during INTERMEDIATE approval has no
                        final approver — the rejecting user is on their own
                        persisted intermediate decision row. The historical
                        fallback is used only for an import whose source
                        data genuinely didn't record one. */}
                    {previewTarget.status === "REJECTED" && !previewTarget.approver && intermediateRejection(previewTarget) ? (
                      (() => {
                        const row = intermediateRejection(previewTarget)!;
                        return (
                          <>
                            <p className="text-sm">
                              {row.approver.name ?? row.approver.email}
                              <span className="text-muted-foreground"> · Intermediate Approver</span>
                            </p>
                            {row.decidedAt && <p className="text-xs text-muted-foreground mt-0.5">{formatDateTime(row.decidedAt)}</p>}
                            {row.businessAssessment && <p className="text-sm whitespace-pre-wrap mt-2">{row.businessAssessment}</p>}
                          </>
                        );
                      })()
                    ) : previewTarget.approver ? (
                      <>
                        <p className="text-sm">
                          {previewTarget.status === "IMPORTED" && "Approved by "}
                          {previewTarget.approver.name ?? previewTarget.approver.email}
                        </p>
                        {(previewTarget.approvedAt ?? previewTarget.rejectedAt) && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {formatDateTime((previewTarget.approvedAt ?? previewTarget.rejectedAt) as Date)}
                          </p>
                        )}
                        {previewTarget.businessAssessment && (
                          <p className="text-sm whitespace-pre-wrap mt-2">{previewTarget.businessAssessment}</p>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">{previewTarget.source === "HISTORICAL_IMPORT" ? "Not recorded (historical import)" : "Not recorded"}</p>
                    )}
                    {previewTarget.project ? (
                      <Link
                        href={`/projects/${previewTarget.project.id}`}
                        className="inline-flex items-center gap-1.5 mt-2 text-sm text-primary hover:underline"
                      >
                        <FolderKanban className="h-3.5 w-3.5" />
                        View Project
                      </Link>
                    ) : previewTarget.status === "APPROVED" && previewTarget.canCompleteSetup ? (
                      <Button size="sm" className="mt-2" asChild>
                        <Link href={`/projects/new?projectRequestId=${previewTarget.id}`}>
                          <Wrench className="h-3.5 w-3.5 mr-1.5" />
                          Complete Project Setup
                        </Link>
                      </Button>
                    ) : previewTarget.status === "APPROVED" ? (
                      <p className="text-xs text-muted-foreground mt-2">
                        Project setup is still pending, from someone with final-approval rights in this department.
                      </p>
                    ) : null}
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
      />
    </div>
  );
}
