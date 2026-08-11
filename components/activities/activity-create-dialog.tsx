"use client";

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
  onCreated: (activity: CreatedActivity) => void;
}

/**
 * Thin Dialog shell around the reusable ActivityNewForm (mode="inline") —
 * same convention as ProjectCreateDialog. All creation business logic
 * (createActivitySchema, activity.create permission + department
 * resolution, ActivityProgressConfig-derived progress, assignment
 * eligibility, sub-department validation, project rollup recalculation)
 * lives in ActivityNewForm/POST /api/activities, never duplicated here.
 *
 * `key` combines departmentId + preselectedProjectId so the form remounts
 * fresh (rather than reusing stale field state) whenever either changes
 * between opens.
 */
export function ActivityCreateDialog({ open, onOpenChange, departmentId, preselectedProjectId, onCreated }: ActivityCreateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Activity</DialogTitle>
        </DialogHeader>
        <ActivityNewForm
          key={`${departmentId}:${preselectedProjectId ?? ""}`}
          departmentId={departmentId}
          mode="inline"
          preselectedProjectId={preselectedProjectId}
          onCreated={(activity) => {
            onOpenChange(false);
            onCreated(activity);
          }}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
