"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Trash2 } from "lucide-react";

interface ProjectDeleteButtonProps {
  projectId: string;
  projectTitle: string;
}

export function ProjectDeleteButton({ projectId, projectTitle }: ProjectDeleteButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to delete project");
      }
      toast.success("Project deleted");
      router.push("/projects");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to delete project");
      setDeleting(false);
    }
  };

  return (
    <>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        <Trash2 className="h-4 w-4 mr-2" />
        Delete Project
      </Button>

      <Dialog open={open} onOpenChange={(o) => { if (!deleting) setOpen(o); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Project</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-2">
            <p className="text-sm text-muted-foreground">
              Are you sure you want to permanently delete{" "}
              <strong className="text-foreground">{projectTitle}</strong>?
            </p>
            <p className="text-sm font-medium text-destructive">
              This action cannot be undone. Activities will be unlinked from the project.
              Any tickets linked to this project will remain but lose their project association.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete Permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
