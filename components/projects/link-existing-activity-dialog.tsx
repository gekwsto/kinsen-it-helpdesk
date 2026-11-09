"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, ArrowRight } from "lucide-react";

interface LinkableActivity {
  id: string;
  title: string;
  isCompleted: boolean;
  /** The Activity's CURRENT Project, if any — null for a standalone Activity. Never the destination; see projectId prop for that. */
  currentProjectId: string | null;
  currentProjectTitle: string | null;
}

interface LinkExistingActivityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** This Project's own title — shown as the reassignment destination in the confirmation step. */
  projectTitle: string;
  /** This Project's own departmentId — candidates are scoped to it (never a cross-department link, same rule PATCH /api/activities/[id] itself enforces). */
  departmentId: string;
  /** Called once after a successful link — the caller re-fetches (router.refresh()), this dialog never maintains its own copy of the Project's Activities list. */
  onLinked: () => void;
}

/**
 * Lets a user attach an EXISTING Activity (from anywhere in this
 * department, standalone or already belonging to another Project) to this
 * Project — never creates a new Activity (that's the existing
 * "+ New Activity" flow), never duplicates the linking logic itself: the
 * actual write is the exact same PATCH /api/activities/[id] (`{ projectId }`)
 * the Activity edit page's own Project dropdown already uses, so every
 * existing rule (department-scope check, request-origin Project's
 * required-fields gate, rollup recalculation, sequence assignment) applies
 * identically and unmodified.
 *
 * An Activity already belonging to a DIFFERENT Project is shown (never
 * silently hidden) but requires an explicit confirmation step naming both
 * the source and destination Project before the PATCH is actually sent —
 * "do not silently move it" without blocking reassignment outright.
 */
export function LinkExistingActivityDialog({ open, onOpenChange, projectId, projectTitle, departmentId, onLinked }: LinkExistingActivityDialogProps) {
  const [activities, setActivities] = useState<LinkableActivity[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!open) {
      setSelectedId(null);
      setSearch("");
      setConfirming(false);
      return;
    }
    let cancelled = false;
    setLoadingList(true);
    fetch(`/api/activities?departmentId=${departmentId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: any[]) => {
        if (cancelled) return;
        const candidates = Array.isArray(data)
          ? data
              .filter((a) => a.projectId !== projectId)
              .map((a) => ({
                id: a.id,
                title: a.title,
                isCompleted: !!a.isCompleted,
                currentProjectId: a.projectId ?? null,
                currentProjectTitle: a.project?.title ?? null,
              }))
          : [];
        setActivities(candidates);
      })
      .catch(() => {
        if (!cancelled) toast.error("Failed to load activities");
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, departmentId, projectId]);

  const results = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return activities;
    return activities.filter((a) => a.title.toLowerCase().includes(q));
  }, [activities, search]);

  const selected = selectedId ? activities.find((a) => a.id === selectedId) ?? null : null;

  const performLink = async () => {
    if (!selectedId) return;
    setLinking(true);
    try {
      const res = await fetch(`/api/activities/${selectedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to link activity");
      }
      toast.success("Activity linked");
      onOpenChange(false);
      onLinked();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to link activity");
      setConfirming(false);
    } finally {
      setLinking(false);
    }
  };

  // Reassigning away from another Project needs an explicit confirmation
  // naming both Projects first; attaching a standalone Activity links
  // immediately, same as before.
  const handleLinkClick = () => {
    if (!selected) return;
    if (selected.currentProjectId) {
      setConfirming(true);
      return;
    }
    performLink();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{confirming ? "Move Activity to this Project?" : "Link Activity"}</DialogTitle>
        </DialogHeader>
        {confirming && selected ? (
          <div className="space-y-4 py-2">
            <p className="text-sm">
              <span className="font-medium">{selected.title}</span> is currently linked to another Project. Linking it here will move it.
            </p>
            <div className="flex items-center gap-2 text-sm rounded-md border p-3 min-w-0">
              <span className="font-medium truncate min-w-0">{selected.currentProjectTitle ?? "Unknown Project"}</span>
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
              <span className="font-medium truncate min-w-0">{projectTitle}</span>
            </div>
          </div>
        ) : (
          // min-w-0 here is load-bearing, not decorative — see the matching
          // comment in link-existing-ticket-dialog.tsx's identical spot:
          // without it, a long "Linked to: …" badge several rows down can
          // force DialogContent's single CSS-grid column wider than its
          // max-w-lg cap, overflowing the search Input and DialogFooter
          // too, not just the row that caused it.
          <div className="space-y-3 py-2 min-w-0">
            <p className="text-xs text-muted-foreground">
              Attach an existing Activity from this department to this Project.
            </p>
            <Input
              placeholder="Search activities…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 text-sm"
            />
            <div className="border rounded-md divide-y max-h-64 overflow-y-auto">
              {loadingList ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : results.length === 0 ? (
                <p className="text-xs text-muted-foreground px-3 py-4 text-center">
                  {activities.length === 0 ? "No other activities in this department." : `No activities match "${search}".`}
                </p>
              ) : (
                results.map((a) => (
                  <label
                    key={a.id}
                    className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/50 min-w-0 ${selectedId === a.id ? "bg-primary/5" : ""}`}
                  >
                    <input
                      type="radio"
                      name="link-activity"
                      className="h-4 w-4 flex-shrink-0"
                      checked={selectedId === a.id}
                      onChange={() => setSelectedId(a.id)}
                    />
                    {/* flex-1 + min-w-0: the row's one flexible element —
                        see the matching comment in
                        link-existing-ticket-dialog.tsx. */}
                    <span className={`text-sm truncate min-w-0 flex-1 ${a.isCompleted ? "text-muted-foreground line-through" : ""}`}>{a.title}</span>
                    {a.currentProjectTitle && (
                      <span
                        className="text-[10px] text-muted-foreground truncate max-w-[40%] flex-shrink-0"
                        title={`Linked to: ${a.currentProjectTitle}`}
                      >
                        Linked to: {a.currentProjectTitle}
                      </span>
                    )}
                  </label>
                ))
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          {confirming && (
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={linking}>
              Back
            </Button>
          )}
          <Button onClick={confirming ? performLink : handleLinkClick} disabled={!selectedId || linking}>
            {linking && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {confirming ? "Confirm Move" : "Link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
