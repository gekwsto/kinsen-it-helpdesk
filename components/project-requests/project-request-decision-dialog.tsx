"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";

const MAX_LENGTH = 5000;

export interface ProjectOwnerOption {
  id: string;
  name: string | null;
  email: string;
}

interface ProjectRequestDecisionDialogProps {
  /** null = closed. Drives title/button wording — never a separate open flag, so there's no desync between "which decision" and "is it open". */
  decision: "approve" | "reject" | null;
  submitting: boolean;
  /** Set only after a failed submit — shown inline, never swallowed into a toast-only message, and the dialog stays open with the typed text intact. */
  serverError: string | null;
  onCancel: () => void;
  onConfirm: (data: { businessAssessment: string; projectOwnerId?: string }) => void;
  /** false for the intermediate stage (confirmed with the user: no written justification there, decision only) — hides the Business Assessment field entirely rather than merely making it optional, since it's never collected for that stage at all. Defaults to true (the FINAL stage, where it remains mandatory). */
  assessmentRequired?: boolean;
  /**
   * Present ONLY for the FINAL stage's approve path — every active,
   * project-assignable user for this request's own department (see
   * getAssignableUsersForProject). When provided and decision === "approve",
   * the approver must pick one; that choice becomes the auto-created
   * Project's owner (see decideApproval). Absent/undefined everywhere else
   * (reject, and the intermediate stage) since no Project is ever created
   * from those paths.
   */
  ownerOptions?: ProjectOwnerOption[];
}

/**
 * The ONE shared decision modal for every Approve/Reject action on a
 * Project Request — contextual title/button text and field set only, never
 * a forked/duplicated dialog per action/stage.
 */
export function ProjectRequestDecisionDialog({
  decision,
  submitting,
  serverError,
  onCancel,
  onConfirm,
  assessmentRequired = true,
  ownerOptions,
}: ProjectRequestDecisionDialogProps) {
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  const [ownerId, setOwnerId] = useState("");
  const [ownerTouched, setOwnerTouched] = useState(false);

  // Reset only when the dialog actually closes (decision -> null) — not on
  // every render, so a server error doesn't wipe what the user typed.
  useEffect(() => {
    if (decision === null) {
      setValue("");
      setTouched(false);
      setOwnerId("");
      setOwnerTouched(false);
    }
  }, [decision]);

  const needsOwner = decision === "approve" && ownerOptions !== undefined;
  const isEmpty = value.trim().length === 0;
  const showEmptyError = assessmentRequired && touched && isEmpty;
  const showOwnerError = needsOwner && ownerTouched && !ownerId;

  const handleConfirm = () => {
    setTouched(true);
    setOwnerTouched(true);
    if (assessmentRequired && isEmpty) return;
    if (needsOwner && !ownerId) return;
    onConfirm({ businessAssessment: value.trim(), projectOwnerId: needsOwner ? ownerId : undefined });
  };

  return (
    <Dialog open={decision !== null} onOpenChange={(open) => !open && !submitting && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{decision === "approve" ? "Approve Project Request" : "Reject Project Request"}</DialogTitle>
          <DialogDescription>Department approval</DialogDescription>
        </DialogHeader>

        {assessmentRequired && (
          <div className="space-y-1.5">
            <label htmlFor="pr-decision-assessment" className="text-sm font-medium">
              Business Assessment <span className="text-destructive">*</span>
            </label>
            <p id="pr-decision-assessment-helper" className="text-xs text-muted-foreground">
              Briefly justify this decision.
            </p>
            <Textarea
              id="pr-decision-assessment"
              rows={4}
              maxLength={MAX_LENGTH}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={() => setTouched(true)}
              disabled={submitting}
              aria-required="true"
              aria-invalid={showEmptyError}
              aria-describedby={showEmptyError ? "pr-decision-assessment-helper pr-decision-assessment-error" : "pr-decision-assessment-helper"}
            />
            {showEmptyError && (
              <p id="pr-decision-assessment-error" className="text-xs text-destructive">
                Business Assessment is required.
              </p>
            )}
          </div>
        )}

        {needsOwner && (
          <div className="space-y-1.5">
            <label htmlFor="pr-decision-project-owner" className="text-sm font-medium">
              Project Owner <span className="text-destructive">*</span>
            </label>
            <p id="pr-decision-project-owner-helper" className="text-xs text-muted-foreground">
              Approving creates a new Project from this request — choose who should own it.
            </p>
            <select
              id="pr-decision-project-owner"
              value={ownerId}
              onChange={(e) => setOwnerId(e.target.value)}
              onBlur={() => setOwnerTouched(true)}
              disabled={submitting}
              aria-required="true"
              aria-invalid={showOwnerError}
              aria-describedby={showOwnerError ? "pr-decision-project-owner-helper pr-decision-project-owner-error" : "pr-decision-project-owner-helper"}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
            >
              <option value="">Select an owner…</option>
              {ownerOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name ?? o.email}
                </option>
              ))}
            </select>
            {showOwnerError && (
              <p id="pr-decision-project-owner-error" className="text-xs text-destructive">
                Select who should own the new Project.
              </p>
            )}
            {ownerOptions.length === 0 && (
              <p className="text-xs text-destructive">No one in this department can currently own a Project. Contact an administrator.</p>
            )}
          </div>
        )}

        {serverError && <p className="text-xs text-destructive">{serverError}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={submitting} variant={decision === "reject" ? "destructive" : "default"}>
            {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {decision === "approve" ? "Approve request" : "Reject request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
