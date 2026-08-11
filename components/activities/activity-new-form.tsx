"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronRight, Loader2, Plus } from "lucide-react";
import { ActivityStatus, ActivityPriority } from "@prisma/client";
import { ProjectCreateDialog } from "@/components/projects/project-create-dialog";

interface Project { id: string; title: string }
interface AssignableUser { id: string; name: string | null; email: string }
interface SubDepartmentOption { id: string; name: string }
interface StatusOption { status: ActivityStatus; label: string; color: string }

export interface CreatedActivity {
  id: string;
  title: string;
  projectId: string | null;
  project: { id: string; title: string } | null;
}

interface ActivityNewFormProps {
  /** Active workspace department — drives which users are shown as eligible assignees; may be null (no workspace resolved yet), matching what POST /api/activities itself falls back to. */
  departmentId: string | null;
  /**
   * "standalone" (default) — the full /activities/new page experience:
   * project list is unscoped (existing behavior, unchanged), success
   * redirects to /activities/{id}.
   * "inline" — embedded in a modal (e.g. from the Ticket create/link flow):
   * `departmentId` is REQUIRED and is always sent explicitly to POST
   * /api/activities (never relies on the active-workspace fallback), the
   * Project choices are scoped to that SAME department only (an activity
   * can never attach to a project from another department — POST
   * /api/activities itself rejects that mismatch; this just never offers
   * the invalid choice), and success calls `onCreated` instead of
   * navigating away.
   */
  mode?: "standalone" | "inline";
  /** Inline mode only — preselects this project (e.g. the Ticket's currently-selected project); still changeable within the same department's project list. */
  preselectedProjectId?: string | null;
  /**
   * Standalone mode only — whether the current user holds `project.create`
   * in `departmentId` (computed server-side by the page, same canActOnEntity
   * gate POST /api/projects itself enforces). Governs whether "+ New
   * Project" is offered at all; unused in inline mode (see the doc comment
   * on the "+ New Project" button below for why inline doesn't get one).
   */
  canCreateProject?: boolean;
  onCreated?: (activity: CreatedActivity) => void;
  onCancel?: () => void;
}

export function ActivityNewForm({ departmentId, mode = "standalone", preselectedProjectId, canCreateProject = false, onCreated, onCancel }: ActivityNewFormProps) {
  const router = useRouter();
  const inline = mode === "inline";
  const [saving, setSaving] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  // Applied once `projects` actually contains it (see the effect below) —
  // never set synchronously at mount. Radix Select's hidden native-<select>
  // autofill sync (SelectBubbleInput) can fire a spurious empty-value
  // change event when the controlled value points at an id whose
  // <SelectItem> isn't registered in the DOM yet (true here at mount, since
  // `projects` starts empty and is only populated once the fetch below
  // resolves) — see components/tickets/ticket-form.tsx's identical fix for
  // the full explanation.
  const [projectId, setProjectId] = useState("");
  const [status, setStatus] = useState<ActivityStatus>(ActivityStatus.TODO);
  const [priority, setPriority] = useState<ActivityPriority>(ActivityPriority.MEDIUM);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [startDate, setStartDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [subDepartments, setSubDepartments] = useState<SubDepartmentOption[]>([]);
  const [subDepartmentId, setSubDepartmentId] = useState("");
  const [statusOptions, setStatusOptions] = useState<StatusOption[]>([]);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);

  useEffect(() => {
    const assignableUrl = `/api/users?assignableFor=activity${departmentId ? `&departmentId=${departmentId}` : ""}`;
    // Inline mode scopes the Project picker to the SAME department the
    // activity itself will be created in — a cross-department project
    // would just be rejected by POST /api/activities anyway (see its own
    // "different department" check), this only avoids offering it in the
    // first place. Standalone /activities/new keeps its existing, unscoped
    // project list unchanged (a pre-existing, out-of-scope behavior — see
    // the final report).
    const projectsUrl = inline && departmentId ? `/api/projects?departmentId=${departmentId}&limit=100` : "/api/projects?limit=100";
    Promise.all([
      fetch(projectsUrl).then((r) => r.json()),
      fetch(assignableUrl).then((r) => (r.ok ? r.json() : [])),
      departmentId ? fetch(`/api/departments/${departmentId}/sub-departments`).then((r) => (r.ok ? r.json() : [])) : Promise.resolve([]),
      departmentId ? fetch(`/api/departments/${departmentId}/activity-statuses`).then((r) => (r.ok ? r.json() : [])) : Promise.resolve([]),
    ])
      .then(([p, u, sd, statuses]) => {
        setProjects(Array.isArray(p?.projects) ? p.projects : []);
        setAssignableUsers(Array.isArray(u) ? u : []);
        setSubDepartments(Array.isArray(sd) ? sd : []);
        const options: StatusOption[] = Array.isArray(statuses) ? statuses.map((row: any) => ({ status: row.status, label: row.label, color: row.color })) : [];
        setStatusOptions(options);
        // Default to the department's own lowest-sortOrder enabled status
        // (e.g. its own "To Do" equivalent) instead of the raw enum's TODO —
        // a department that renamed/reordered its statuses gets the right
        // default, not a fixed guess.
        if (options.length > 0) setStatus(options[0].status);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departmentId, inline]);

  // Applies the preselected Project only once it's confirmed present in
  // `projects` — see the `projectId` state's own doc comment above for why
  // this can't just be the state's initial value.
  useEffect(() => {
    if (preselectedProjectId && projects.some((p) => p.id === preselectedProjectId)) {
      setProjectId(preselectedProjectId);
    }
  }, [projects, preselectedProjectId]);

  // Same deferred/pending-selection pattern as the Ticket inline creation
  // flow (components/tickets/ticket-form.tsx) — reused verbatim, not
  // reimplemented: a just-created Project can't be selected in the SAME
  // commit as adding it to `projects`, since Radix Select's hidden
  // native-<select> autofill sync (SelectBubbleInput) can fire a spurious
  // empty-value change event when the value points at an id whose
  // <SelectItem> isn't registered in the DOM yet. Applying the selection
  // only once the item is confirmed present in `projects` guarantees the
  // <SelectItem> already exists.
  const [pendingProjectSelection, setPendingProjectSelection] = useState<string | null>(null);
  useEffect(() => {
    if (pendingProjectSelection && projects.some((p) => p.id === pendingProjectSelection)) {
      setProjectId(pendingProjectSelection);
      setPendingProjectSelection(null);
    }
  }, [projects, pendingProjectSelection]);

  const handleProjectCreated = (project: { id: string; title: string }) => {
    setProjects((prev) => (prev.some((p) => p.id === project.id) ? prev : [...prev, { id: project.id, title: project.title }]));
    setPendingProjectSelection(project.id);
  };

  const toggleUser = (userId: string) => {
    setSelectedUserIds((prev) =>
      prev.includes(userId) ? prev.filter((x) => x !== userId) : [...prev, userId]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    if (inline && !departmentId) {
      toast.error("No department resolved for this activity.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/activities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description: description || undefined,
          projectId: projectId || undefined,
          status,
          priority,
          assignedUserIds: selectedUserIds,
          startDate: startDate || undefined,
          dueDate: dueDate || undefined,
          subDepartmentId: subDepartmentId || undefined,
          // Explicit in BOTH modes — resolves to the identical department
          // standalone /activities/new already got via the active-workspace
          // fallback (this `departmentId` prop IS that same value there),
          // so this changes nothing observable for standalone; inline mode
          // requires it (never relies on the fallback, which is scoped to
          // the CALLER's active workspace, not necessarily the ticket's own).
          departmentId: departmentId || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to create activity");
      }
      const activity = await res.json();
      toast.success("Activity created");
      if (inline) {
        onCreated?.({ id: activity.id, title: activity.title, projectId: activity.projectId ?? null, project: activity.project ?? null });
      } else {
        router.push(`/activities/${activity.id}`);
      }
    } catch (error: any) {
      toast.error(error.message ?? "Failed to create activity");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={inline ? "" : "space-y-6 max-w-2xl"}>
      {!inline && (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/activities" className="hover:text-foreground">Activities</Link>
          <ChevronRight className="h-4 w-4" />
          <span className="text-foreground font-medium">New Activity</span>
        </div>
      )}

      <Card className={inline ? "border-none shadow-none" : undefined}>
        {!inline && (
          <CardHeader>
            <CardTitle>Create Activity</CardTitle>
          </CardHeader>
        )}
        <CardContent className={inline ? "px-0" : undefined}>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title">Title *</Label>
              <Input
                id="title"
                placeholder="Activity title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                placeholder="Describe the activity..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as ActivityStatus)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {statusOptions.map((s) => (
                      <SelectItem key={s.status} value={s.status}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Priority</Label>
                <Select value={priority} onValueChange={(v) => setPriority(v as ActivityPriority)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(ActivityPriority).map((p) => (
                      <SelectItem key={p} value={p}>{p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Project (optional)</Label>
              <div className="flex gap-1.5">
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger>
                    <SelectValue placeholder="No project (standalone)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">No project</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.title}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/*
                  Only offered in standalone mode. The inline mode
                  (ActivityCreateDialog, used from the Ticket create/link
                  flows) is already a Dialog itself — nesting a second
                  Project-create Dialog inside it would require the same
                  dialog-swap treatment the Ticket flow uses for its OWN
                  nested dialogs, and Part A of this task only specifies
                  /activities/new and Edit Activity, not a third nesting
                  level under Tickets. See the final report.
                */}
                {!inline && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 gap-1"
                    disabled={!departmentId || !canCreateProject}
                    title={
                      !departmentId
                        ? "Select a department first."
                        : !canCreateProject
                        ? "You don't have permission to create projects in this department."
                        : undefined
                    }
                    onClick={() => setProjectDialogOpen(true)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    New
                  </Button>
                )}
              </div>
              {!inline && !departmentId && (
                <p className="text-xs text-muted-foreground">
                  Select a department first.
                </p>
              )}
            </div>

            {subDepartments.length > 0 && (
              <div className="space-y-2">
                <Label>Sub-Department (optional)</Label>
                <Select value={subDepartmentId || "__none__"} onValueChange={(v) => setSubDepartmentId(v === "__none__" ? "" : v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {subDepartments.map((sd) => (
                      <SelectItem key={sd.id} value={sd.id}>{sd.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-2">
              <Label>Assigned Users</Label>
              <p className="text-xs text-muted-foreground">
                Only users eligible for this workspace are listed.
              </p>
              {assignableUsers.length > 0 ? (
                <div className="border rounded-md divide-y max-h-40 overflow-y-auto">
                  {assignableUsers.map((u) => (
                    <label
                      key={u.id}
                      className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded"
                        checked={selectedUserIds.includes(u.id)}
                        onChange={() => toggleUser(u.id)}
                      />
                      <span className="text-sm">{u.name ?? u.email}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground border rounded-md px-3 py-2">
                  No eligible users for this workspace yet.
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="startDate">Start Date</Label>
                <Input
                  id="startDate"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="dueDate">Due Date</Label>
                <Input
                  id="dueDate"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </div>
            </div>

            <div className="flex gap-3 pt-2">
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Create Activity
              </Button>
              <Button type="button" variant="outline" onClick={inline ? onCancel : () => router.back()} disabled={saving}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {!inline && departmentId && (
        <ProjectCreateDialog
          open={projectDialogOpen}
          onOpenChange={setProjectDialogOpen}
          departmentId={departmentId}
          onCreated={handleProjectCreated}
        />
      )}
    </div>
  );
}
