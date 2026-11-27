"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { minutesToDurationInputs, parseDurationInputs, type DurationInputs } from "@/lib/resolution-time";

interface ResolutionTimeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "resolve": Cancel / Resolve Ticket. "edit": Cancel / Save. */
  mode: "resolve" | "edit";
  /** Currently saved value — prefilled (normalized, 1 day = 8h); NULL leaves every field empty. */
  initialMinutes: number | null;
  /** Receives total minutes, or null when every field was left empty. Resolve to true to close the dialog. */
  onSubmit: (minutes: number | null) => Promise<boolean>;
}

const FIELDS: { key: keyof DurationInputs; label: string }[] = [
  { key: "days", label: "Days" },
  { key: "hours", label: "Hours" },
  { key: "minutes", label: "Minutes" },
];

/**
 * The single duration dialog used by every interactive resolution path
 * (Resolve, Change Status -> Resolved, Kanban drop on Resolved) and by
 * Edit Resolution Time. Every field is optional; all-empty means "not
 * recorded" (NULL) and never blocks resolving.
 */
export function ResolutionTimeDialog({ open, onOpenChange, mode, initialMinutes, onSubmit }: ResolutionTimeDialogProps) {
  const [inputs, setInputs] = useState<DurationInputs>(() => minutesToDurationInputs(initialMinutes));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Fresh prefill from the saved value every time the dialog opens — an
  // abandoned (cancelled) edit never leaks into the next opening.
  useEffect(() => {
    if (open) {
      setInputs(minutesToDurationInputs(initialMinutes));
      setError(null);
    }
  }, [open, initialMinutes]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseDurationInputs(inputs);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setSubmitting(true);
    try {
      if (await onSubmit(parsed.minutes)) onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  const isResolve = mode === "resolve";

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent>
        <form onSubmit={handleSubmit} noValidate data-testid="resolution-time-form">
          <DialogHeader>
            <DialogTitle>{isResolve ? "Resolve this ticket?" : "Edit Resolution Time"}</DialogTitle>
            <DialogDescription>
              {isResolve
                ? "Optionally record the actual effort spent resolving this ticket. Leave all fields empty to resolve without recording it."
                : "Record the actual effort spent resolving this ticket. Clear all fields to remove the recorded time."}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-2">
            <div className="grid grid-cols-3 gap-3">
              {FIELDS.map(({ key, label }) => (
                <div key={key} className="space-y-1.5">
                  <Label htmlFor={`resolution-time-${key}`}>{label}</Label>
                  <Input
                    id={`resolution-time-${key}`}
                    // Text + numeric keypad rather than type="number": a number
                    // input reports unparseable text as "" (silently "empty"),
                    // while this keeps exactly what was typed so
                    // parseDurationInputs can reject it.
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="0"
                    value={inputs[key]}
                    disabled={submitting}
                    onChange={(e) => {
                      setInputs((prev) => ({ ...prev, [key]: e.target.value }));
                      setError(null);
                    }}
                  />
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">1 day = 8 working hours.</p>
            {error && (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {isResolve ? "Resolve Ticket" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
