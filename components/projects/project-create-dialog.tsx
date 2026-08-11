"use client";

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
  onCreated: (project: CreatedProject) => void;
}

/**
 * Thin Dialog shell around the reusable ProjectForm (mode="inline") — used
 * anywhere a Project needs to be created without leaving the current page
 * (currently: Create Ticket, and the Link Project/Activity dialog on an
 * existing Ticket). All creation business logic — validation, department
 * scoping via POST /api/projects's own resolveDepartmentForCreate,
 * sub-department validation, member assignment eligibility — lives in
 * ProjectForm/the API route, never duplicated here.
 *
 * `key={departmentId}` on ProjectForm forces a fresh form instance (empty
 * fields) whenever the target department actually changes between opens,
 * rather than reusing stale field values from a previous department.
 */
export function ProjectCreateDialog({ open, onOpenChange, departmentId, departmentName, onCreated }: ProjectCreateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Project</DialogTitle>
        </DialogHeader>
        <ProjectForm
          key={departmentId}
          departments={[]}
          mode="inline"
          fixedDepartmentId={departmentId}
          fixedDepartmentName={departmentName}
          onCreated={(project) => {
            onOpenChange(false);
            onCreated(project);
          }}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
