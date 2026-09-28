"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ActivityNewForm, type CreatedActivity } from "@/components/activities/activity-new-form";

interface ActivityCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  departmentId: string;
  /** Preselects this project in the form (e.g. the Ticket's currently-selected project) — still changeable within the same department. */
  preselectedProjectId?: string | null;
  /**
   * Server-computed: whether the current user holds effective activity.edit
   * (global grant OR `departmentId`'s own grant, via
   * hasEffectiveEntityPermission) in this department — see each caller
   * (ticket-form.tsx / ticket-actions.tsx). activity.create never implies
   * activity.edit; this governs whether the form offers attachment
   * selection at all. Defaults to false (no attachments offered) for any
   * caller that doesn't pass it.
   */
  canUploadAttachments?: boolean;
  onCreated: (activity: CreatedActivity) => void;
}

/**
 * Thin Dialog shell around the reusable ActivityNewForm (mode="inline") —
 * same convention as ProjectCreateDialog. All creation business logic
 * (createActivitySchema, activity.create permission + department
 * resolution, ActivityProgressConfig-derived progress, assignment
 * eligibility, sub-department validation, project rollup recalculation,
 * and now attachment upload) lives in ActivityNewForm/the API routes, never
 * duplicated here.
 *
 * `key` combines departmentId + preselectedProjectId + `open` so the form
 * remounts genuinely fresh (rather than reusing stale field/attachment
 * state) whenever any of those change OR whenever the dialog is reopened —
 * see ProjectCreateDialog's own doc comment for why `open` specifically
 * matters now.
 *
 * `locked` — reported by ActivityNewForm via `onLockChange` — blocks
 * Radix's own Escape/backdrop-click/close-button dismissal while the
 * Activity has been created but its attachments are still pending or have
 * failed.
 */
export function ActivityCreateDialog({ open, onOpenChange, departmentId, preselectedProjectId, canUploadAttachments = false, onCreated }: ActivityCreateDialogProps) {
  const [locked, setLocked] = useState(false);

  const guardedOnOpenChange = (next: boolean) => {
    if (!next && locked) return;
    onOpenChange(next);
  };

  const handleCreated = (activity: CreatedActivity) => {
    setLocked(false);
    onOpenChange(false);
    onCreated(activity);
  };

  return (
    <Dialog open={open} onOpenChange={guardedOnOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Activity</DialogTitle>
        </DialogHeader>
        <ActivityNewForm
          key={`${departmentId}:${preselectedProjectId ?? ""}:${open}`}
          departmentId={departmentId}
          mode="inline"
          preselectedProjectId={preselectedProjectId}
          canUploadAttachments={canUploadAttachments}
          onLockChange={setLocked}
          onCreated={handleCreated}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
