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
  onConfirm: (businessAssessment: string) => void;
}

/**
 * The ONE shared decision modal for every Approve/Reject action on a
 * Project Request — contextual title/button text only, never a
 * forked/duplicated dialog per action. Business Assessment is mandatory for
 * BOTH approve and reject; empty/whitespace-only is blocked client-side
 * (inline error, never a silent no-op) in addition to the server's own
 * independent re-validation.
 */
export function ProjectRequestDecisionDialog({ decision, submitting, serverError, onCancel, onConfirm }: ProjectRequestDecisionDialogProps) {
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
  const showEmptyError = touched && isEmpty;

  const handleConfirm = () => {
    setTouched(true);
    if (isEmpty) return;
    onConfirm(value.trim());
  };

  return (
    <Dialog open={decision !== null} onOpenChange={(open) => !open && !submitting && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{decision === "approve" ? "Approve Project Request" : "Reject Project Request"}</DialogTitle>
          <DialogDescription>Department approval</DialogDescription>
        </DialogHeader>

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
          {serverError && <p className="text-xs text-destructive">{serverError}</p>}
        </div>

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
