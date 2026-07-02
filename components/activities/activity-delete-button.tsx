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

interface ActivityDeleteButtonProps {
  activityId: string;
  activityTitle: string;
  projectId?: string | null;
}

export function ActivityDeleteButton({ activityId, activityTitle, projectId }: ActivityDeleteButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/activities/${activityId}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to delete activity");
      }
      toast.success("Activity deleted");
      router.push(projectId ? `/projects/${projectId}` : "/activities");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to delete activity");
      setDeleting(false);
    }
  };

  return (
    <>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        <Trash2 className="h-4 w-4 mr-2" />
        Delete Activity
      </Button>

      <Dialog open={open} onOpenChange={(o) => { if (!deleting) setOpen(o); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Activity</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-2">
            <p className="text-sm text-muted-foreground">
              Are you sure you want to permanently delete{" "}
              <strong className="text-foreground">{activityTitle}</strong>?
            </p>
            <p className="text-sm font-medium text-destructive">
              This action cannot be undone. Any tickets linked to this activity will remain
              but lose their activity association.
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
