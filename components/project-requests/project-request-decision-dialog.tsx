"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";

const MAX_LENGTH = 5000;

interface ProjectRequestDecisionDialogProps {
  /** null = closed. Drives title/button wording — never a separate open flag, so there's no desync between "which decision" and "is it open". */
  decision: "approve" | "reject" | null;
  submitting: boolean;
  /** Set only after a failed submit — shown inline, never swallowed into a toast-only message, and the dialog stays open with the typed text intact. */
  serverError: string | null;
  onCancel: () => void;
  onConfirm: (data: { businessAssessment: string }) => void;
  /** false for the intermediate stage (confirmed with the user: no written justification there, decision only) — hides the Business Assessment field entirely rather than merely making it optional, since it's never collected for that stage at all. Defaults to true (the FINAL stage, where it remains mandatory). */
  assessmentRequired?: boolean;
}

/**
 * The ONE shared decision modal for every Approve/Reject action on a
 * Project Request — contextual title/button text and field set only, never
 * a forked/duplicated dialog per action/stage. FINAL approval is
 * responsible only for the decision itself; Project setup (owner,
 * timeline, budget, etc.) is a deliberately separate follow-up step — see
 * components/projects/project-form.tsx's "fromRequest" mode — so this
 * dialog never collects anything beyond the decision and its assessment.
 */
export function ProjectRequestDecisionDialog({
  decision,
  submitting,
  serverError,
  onCancel,
  onConfirm,
  assessmentRequired = true,
}: ProjectRequestDecisionDialogProps) {
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);

  // Reset only when the dialog actually closes (decision -> null) — not on
  // every render, so a server error doesn't wipe what the user typed.
  useEffect(() => {
    if (decision === null) {
      setValue("");
      setTouched(false);
    }
  }, [decision]);

  const isEmpty = value.trim().length === 0;
  const showEmptyError = assessmentRequired && touched && isEmpty;

  const handleConfirm = () => {
    setTouched(true);
    if (assessmentRequired && isEmpty) return;
    onConfirm({ businessAssessment: value.trim() });
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

        {assessmentRequired && decision === "approve" && (
          <p className="text-xs text-muted-foreground">
            After approval, you&apos;ll be taken to set up the Project for this request.
          </p>
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
