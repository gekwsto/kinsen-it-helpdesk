"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProjectForm, type CreatedProject } from "@/components/projects/project-form";

interface ProjectCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  departmentId: string;
  departmentName?: string;
  /**
   * Server-computed: whether the current user holds effective project.edit
   * (global grant OR `departmentId`'s own grant, via
   * hasEffectiveEntityPermission) in this department. project.create never
   * implies project.edit; this governs whether the form offers attachment
   * selection at all. Every real caller computes this server-side against
   * the actual target department and passes it through unchanged —
   * ticket-form.tsx / ticket-actions.tsx (Ticket create/link flows) and
   * activity-new-form.tsx's own nested "+ New Project" dialog (standalone
   * /activities/new, checked against project.edit for that SAME fixed
   * department — see app/(main)/activities/new/page.tsx's
   * canUploadProjectAttachments). Defaults to false for any caller that
   * doesn't pass it.
   */
  canUploadAttachments?: boolean;
  onCreated: (project: CreatedProject) => void;
}

/**
 * Thin Dialog shell around the reusable ProjectForm (mode="inline") — used
 * anywhere a Project needs to be created without leaving the current page
 * (currently: Create Ticket, and the Link Project/Activity dialog on an
 * existing Ticket). All creation business logic — validation, department
 * scoping via POST /api/projects's own resolveDepartmentForCreate,
 * sub-department validation, member assignment eligibility, and now
 * attachment upload — lives in ProjectForm/the API routes, never
 * duplicated here.
 *
 * `key` includes `open` (not just `departmentId`) so ProjectForm gets a
 * genuinely FRESH instance every time this dialog opens — critical now that
 * a completed-with-attachments run leaves internal state (createdEntity,
 * entries) that must never leak into the NEXT time the user opens "+ New
 * Project" for the same department; a stale `createdEntity` would otherwise
 * make a freshly-reopened dialog immediately render the previous run's
 * upload panel instead of a blank form.
 *
 * `locked` — reported by ProjectForm via `onLockChange` — blocks Radix's
 * own Escape/backdrop-click/close-button dismissal while the Project has
 * been created but its attachments are still pending or have failed; the
 * user must finish through a successful upload or the panel's own Continue
 * button (which calls `onOpenChange` directly, bypassing this guard — see
 * `handleCreated` below).
 */
export function ProjectCreateDialog({ open, onOpenChange, departmentId, departmentName, canUploadAttachments = false, onCreated }: ProjectCreateDialogProps) {
  const [locked, setLocked] = useState(false);

  const guardedOnOpenChange = (next: boolean) => {
    if (!next && locked) return;
    onOpenChange(next);
  };

  const handleCreated = (project: CreatedProject) => {
    setLocked(false);
    onOpenChange(false);
    onCreated(project);
  };

  return (
    <Dialog open={open} onOpenChange={guardedOnOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Project</DialogTitle>
        </DialogHeader>
        <ProjectForm
          key={`${departmentId}:${open}`}
          departments={[]}
          editableDepartmentIds={[]}
          mode="inline"
          fixedDepartmentId={departmentId}
          fixedDepartmentName={departmentName}
          inlineCanUploadAttachments={canUploadAttachments}
          onLockChange={setLocked}
          onCreated={handleCreated}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
