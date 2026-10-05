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
import { useCreateWithAttachments } from "@/hooks/use-create-with-attachments";
import { PendingAttachmentsField } from "@/components/attachments/pending-attachments-field";
import { PostCreateUploadPanel } from "@/components/attachments/post-create-upload-panel";

// projectRequestId is the canonical, server-resolved provenance signal —
// present on every /api/projects row already (a plain scalar column, never
// select-limited there) — reused here verbatim to show/require the
// request-origin fields below, never a client-invented flag.
interface Project { id: string; title: string; projectRequestId: string | null }
interface AssignableUser { id: string; name: string | null; email: string }
interface SubDepartmentOption { id: string; name: string }
interface StatusOption { status: ActivityStatus; label: string; color: string }
interface TaskTypeOption { id: string; name: string; cost: number }

/** Whole calendar days between two date-only (YYYY-MM-DD) strings — a client-side PREVIEW only, purely for UX; mirrors wholeCalendarDaysBetween in lib/date-only.ts, but the server always recomputes and persists its own authoritative value. Returns null until both dates are present/valid. */
function previewCalendarDays(startStr: string, finishStr: string): number | null {
  if (!startStr || !finishStr) return null;
  const start = new Date(startStr);
  const finish = new Date(finishStr);
  if (Number.isNaN(start.getTime()) || Number.isNaN(finish.getTime())) return null;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const startUtcMidnight = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const finishUtcMidnight = Date.UTC(finish.getUTCFullYear(), finish.getUTCMonth(), finish.getUTCDate());
  return Math.round((finishUtcMidnight - startUtcMidnight) / MS_PER_DAY);
}

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
  /** Preselects this project — in inline mode, the Ticket's currently-selected project; in standalone mode, the ?projectId= the server page already resolved/validated (see app/(main)/activities/new/page.tsx). Still changeable afterward (the Project selector is never locked); changing it re-derives every Project-dependent field (request-origin block, eligible owner/related-users) from the newly-selected Project, the same way it already does on first load. */
  preselectedProjectId?: string | null;
  /**
   * Standalone mode only — whether the current user holds `project.create`
   * in `departmentId` (computed server-side by the page, same canActOnEntity
   * gate POST /api/projects itself enforces). Governs whether "+ New
   * Project" is offered at all; unused in inline mode (see the doc comment
   * on the "+ New Project" button below for why inline doesn't get one).
   */
  canCreateProject?: boolean;
  /**
   * Standalone mode only — whether the current user holds effective
   * project.edit (global grant OR `departmentId`'s own grant, via
   * hasEffectiveEntityPermission — see app/(main)/activities/new/page.tsx)
   * for the SAME department the nested "+ New Project" dialog creates into.
   * project.create never implies project.edit; this governs whether THAT
   * dialog's own Attachments section is offered — completely independent
   * of `canUploadAttachments` below, which is this Activity's own. Unused
   * in inline mode (the nested dialog is never rendered there at all).
   */
  canUploadProjectAttachments?: boolean | null;
  /**
   * Whether the current user holds effective activity.edit (global grant OR
   * `departmentId`'s own grant — the hasEffectiveEntityPermission union,
   * computed server-side by the caller: app/(main)/activities/new/page.tsx
   * for standalone, ticket-form.tsx/ticket-actions.tsx for inline) for this
   * form's fixed department. activity.create never implies activity.edit —
   * they're independently grantable, same as project.create/project.edit.
   * Governs whether the Attachments section is offered at all, in BOTH
   * modes (Activity's department is always fixed, never a Select, so one
   * capability value covers standalone and inline alike). POST
   * /api/activities/[id]/attachments still independently re-checks this
   * regardless of what the client renders.
   */
  canUploadAttachments?: boolean | null;
  /**
   * Inline mode only — called whenever it becomes unsafe (or safe again) to
   * silently dismiss the enclosing dialog via Escape/backdrop-click/close-
   * button: true from the moment the Activity has been created with
   * attachments still pending/failed, until the upload phase is fully
   * resolved. The dialog shell (ActivityCreateDialog) is what actually
   * blocks the close; this form only ever reports the state.
   */
  onLockChange?: (locked: boolean) => void;
  onCreated?: (activity: CreatedActivity) => void;
  onCancel?: () => void;
}

export function ActivityNewForm({ departmentId, mode = "standalone", preselectedProjectId, canCreateProject = false, canUploadProjectAttachments = null, canUploadAttachments = null, onLockChange, onCreated, onCancel }: ActivityNewFormProps) {
  const router = useRouter();
  const inline = mode === "inline";
  const [saving, setSaving] = useState(false);
  const attachments = useCreateWithAttachments<CreatedActivity>((id) => `/api/activities/${id}`);

  // Reports "safe to silently dismiss the dialog right now" to the inline
  // dialog shell — locked from the moment creation succeeded WITH
  // attachments to upload, until either every upload succeeded or the user
  // explicitly continued. Never fires in standalone mode (no dialog to guard).
  useEffect(() => {
    if (!inline) return;
    onLockChange?.(attachments.createdEntity !== null && attachments.entries.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inline, attachments.createdEntity, attachments.entries.length]);
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

  // Request-origin-only — only ever shown/required when the SELECTED
  // Project itself originates from a Project Request (see `isRequestOrigin`
  // below, derived from projectId + `projects`, never a flag of its own).
  const [expectedStartDate, setExpectedStartDate] = useState("");
  const [expectedFinishDate, setExpectedFinishDate] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [taskTypeId, setTaskTypeId] = useState("");
  const [taskTypes, setTaskTypes] = useState<TaskTypeOption[]>([]);

  useEffect(() => {
    const assignableUrl = `/api/users?assignableFor=activity${departmentId ? `&departmentId=${departmentId}` : ""}`;
    // Inline mode (and standalone WITH a preselected Project — e.g. arriving
    // from a Project's own "Add Activity" button) scopes the Project picker
    // to the SAME department the activity itself will be created in — a
    // cross-department project would just be rejected by POST
    // /api/activities anyway (see its own "different department" check),
    // this only avoids offering it in the first place. Scoping is also what
    // GUARANTEES the preselected project is actually present in the fetched
    // list: an unscoped `limit=100` fetch has no ordering guarantee that
    // includes any specific project, which would silently defeat the
    // preselection effect below (`projects.some(...)` would never find it).
    // Plain standalone /activities/new (no preselection at all) keeps its
    // existing, unscoped project list unchanged — unrelated to this fix.
    const projectsUrl = (inline || preselectedProjectId) && departmentId ? `/api/projects?departmentId=${departmentId}&limit=100` : "/api/projects?limit=100";
    Promise.all([
      fetch(projectsUrl).then((r) => r.json()),
      fetch(assignableUrl).then((r) => (r.ok ? r.json() : [])),
      departmentId ? fetch(`/api/departments/${departmentId}/sub-departments`).then((r) => (r.ok ? r.json() : [])) : Promise.resolve([]),
      departmentId ? fetch(`/api/departments/${departmentId}/activity-statuses`).then((r) => (r.ok ? r.json() : [])) : Promise.resolve([]),
      fetch("/api/activity-task-types").then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([p, u, sd, statuses, taskTypeOptions]) => {
        setProjects(Array.isArray(p?.projects) ? p.projects : []);
        setAssignableUsers(Array.isArray(u) ? u : []);
        setSubDepartments(Array.isArray(sd) ? sd : []);
        setTaskTypes(Array.isArray(taskTypeOptions) ? taskTypeOptions : []);
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
  }, [departmentId, inline, preselectedProjectId]);

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
    // Always a manual creation (the nested "+ New Project" dialog has no
    // request-origin path of its own) — projectRequestId is genuinely null
    // here, never a placeholder.
    setProjects((prev) => (prev.some((p) => p.id === project.id) ? prev : [...prev, { id: project.id, title: project.title, projectRequestId: null }]));
    setPendingProjectSelection(project.id);
  };

  const toggleUser = (userId: string) => {
    setSelectedUserIds((prev) =>
      prev.includes(userId) ? prev.filter((x) => x !== userId) : [...prev, userId]
    );
  };

  // The ONLY place this is decided — a plain derived value from the
  // currently SELECTED Project's own server-resolved projectRequestId,
  // never a flag this form invents or sends. POST /api/activities
  // independently re-derives the identical rule server-side from the
  // Project row itself; this only drives which fields the UI shows/
  // requires client-side.
  const selectedProject = projects.find((p) => p.id === projectId);
  const isRequestOrigin = !!selectedProject?.projectRequestId;
  const selectedTaskType = taskTypes.find((t) => t.id === taskTypeId);
  const previewExpectedDays = previewCalendarDays(expectedStartDate, expectedFinishDate);
  // Client-side PREVIEW only (same convention as previewExpectedDays above)
  // — POST /api/activities independently computes and returns the
  // authoritative Estimated Cost (taskTypeCost × expectedDays) via
  // computeActivityFinancials; this never gets sent, only shown ahead of
  // creation so the number isn't a total surprise.
  const previewEstimatedCost =
    selectedTaskType && previewExpectedDays !== null ? selectedTaskType.cost * previewExpectedDays : null;

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
    // Client-side UX guard only — POST /api/activities independently
    // re-derives isRequestOrigin from the Project row itself and enforces
    // the identical requirement; this just avoids a round-trip for the
    // obvious case.
    if (isRequestOrigin) {
      if (!expectedStartDate) return toast.error("Expected Start is required for an Activity under a request-origin Project.");
      if (!expectedFinishDate) return toast.error("Expected Finish is required for an Activity under a request-origin Project.");
      if (new Date(expectedFinishDate) < new Date(expectedStartDate)) return toast.error("Expected Finish cannot be before Expected Start.");
      if (!taskTypeId) return toast.error("Select a Task Type.");
      if (!ownerId) return toast.error("Select an Owner.");
      if (selectedUserIds.length === 0) return toast.error("Select at least one Related User.");
    }
    setSaving(true);
    try {
      // Two-step architecture: create the Activity first (unchanged
      // request/route), THEN — only once it has a real, server-issued id —
      // upload any selected attachments through the existing protected
      // POST /api/activities/[id]/attachments route. Never the reverse,
      // never a client-generated id, never a multipart create request.
      const { entity: activity, allUploaded } = await attachments.submit(async () => {
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
            ...(isRequestOrigin
              ? {
                  expectedStartDate,
                  expectedFinishDate,
                  ownerId,
                  taskTypeId,
                }
              : {}),
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error ?? "Failed to create activity");
        }
        return res.json();
      });
      toast.success("Activity created");
      if (allUploaded) {
        // No attachments selected, or every upload succeeded. Inline: call
        // onCreated (the Ticket-linking callback) exactly once, now — never
        // before uploads finished. Standalone: navigate immediately, exactly
        // like this form always has. A partial/total upload failure instead
        // falls through to the PostCreateUploadPanel rendered below; inline
        // waits there for Retry/Continue before ever calling onCreated,
        // standalone waits for Continue before navigating.
        if (inline) {
          onCreated?.({ id: activity.id, title: activity.title, projectId: activity.projectId ?? null, project: activity.project ?? null });
        } else {
          router.push(`/activities/${activity.id}`);
        }
      }
    } catch (error: any) {
      toast.error(error.message ?? "Failed to create activity");
    } finally {
      setSaving(false);
    }
  };

  // The Activity already exists (create succeeded) and had attachments to
  // upload — the ORIGINAL form is never shown again from this point on
  // (nothing left to resubmit against), only upload progress + Retry/
  // Continue. On a fully successful upload this branch is never reached at
  // all: handleSubmit above navigates away directly.
  if (attachments.createdEntity && attachments.entries.length > 0) {
    const finish = () => {
      if (inline) {
        // Exactly once — this is the ONLY place inline's onCreated fires
        // from the panel (Continue, or a fully-successful Retry below).
        onCreated?.(attachments.createdEntity!);
      } else {
        router.push(`/activities/${attachments.createdEntity!.id}`);
      }
    };
    return (
      <PostCreateUploadPanel
        entityLabel="Activity"
        entries={attachments.entries}
        uploading={attachments.phase === "uploading"}
        onRetryFailed={async () => {
          const { allUploaded } = await attachments.retryFailed();
          // Canonical rule, identical in both modes: a Retry that clears
          // every remaining failure finishes automatically (same as the
          // initial upload's own "all succeeded" path in handleSubmit) —
          // the panel (and its Continue button) exists only to let the
          // user proceed EARLY while a failure still remains.
          if (allUploaded) finish();
        }}
        onContinue={finish}
      />
    );
  }

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

            {/* Request-origin-only — only ever shown when the SELECTED
                Project itself originates from a Project Request (see
                isRequestOrigin above). A normal/manual Project's Activity
                creation never sees this block at all, never an empty
                version of it. */}
            {isRequestOrigin && (
              <div className="space-y-4 rounded-lg border p-4 bg-muted/20">
                <div>
                  <h3 className="text-sm font-semibold">Project Request Setup</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">Required for Activities created under a Project that originated from a Project Request.</p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="expected-start">
                      Expected Start <span className="text-destructive">*</span>
                    </Label>
                    <Input id="expected-start" type="date" value={expectedStartDate} onChange={(e) => setExpectedStartDate(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="expected-finish">
                      Expected Finish <span className="text-destructive">*</span>
                    </Label>
                    <Input id="expected-finish" type="date" value={expectedFinishDate} onChange={(e) => setExpectedFinishDate(e.target.value)} />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="expected-days">Expected Days</Label>
                  {/* readOnly (never disabled) — same convention as
                      Project.expectedTotalInitialDays's own create-time
                      preview input (components/projects/project-form.tsx):
                      full visual weight, never typable, never submitted —
                      the server independently computes and persists its
                      own authoritative value. */}
                  <Input
                    id="expected-days"
                    type="text"
                    inputMode="none"
                    readOnly
                    aria-readonly="true"
                    tabIndex={-1}
                    value={previewExpectedDays !== null ? `${previewExpectedDays} day${previewExpectedDays === 1 ? "" : "s"}` : ""}
                    placeholder="Select both dates to calculate"
                    className="cursor-default bg-muted/40"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="task-type">
                    Task Type <span className="text-destructive">*</span>
                  </Label>
                  <Select value={taskTypeId} onValueChange={setTaskTypeId}>
                    <SelectTrigger id="task-type">
                      <SelectValue placeholder="Select a Task Type…" />
                    </SelectTrigger>
                    <SelectContent>
                      {taskTypes.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {/* Informational only — never the authoritative value;
                      the server independently loads the Task Type and
                      snapshots ITS OWN current cost at creation time. */}
                  {selectedTaskType && (
                    <p className="text-xs text-muted-foreground">Cost: {selectedTaskType.cost.toFixed(2)} EUR (snapshotted at creation)</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="estimated-cost">Estimated Cost</Label>
                  <Input
                    id="estimated-cost"
                    type="text"
                    inputMode="none"
                    readOnly
                    aria-readonly="true"
                    tabIndex={-1}
                    value={previewEstimatedCost !== null ? `${previewEstimatedCost.toFixed(2)} EUR` : ""}
                    placeholder="Select a Task Type and both dates to calculate"
                    className="cursor-default bg-muted/40"
                  />
                  <p className="text-xs text-muted-foreground">Task Type cost × Expected Days. Calculated automatically.</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="owner">
                    Owner <span className="text-destructive">*</span>
                  </Label>
                  <Select value={ownerId} onValueChange={setOwnerId}>
                    <SelectTrigger id="owner">
                      <SelectValue placeholder="Select an owner…" />
                    </SelectTrigger>
                    <SelectContent>
                      {assignableUsers.map((u) => (
                        <SelectItem key={u.id} value={u.id}>
                          {u.name ?? u.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label>{isRequestOrigin ? <>Related Users <span className="text-destructive">*</span></> : "Assigned Users"}</Label>
              <p className="text-xs text-muted-foreground">
                {isRequestOrigin ? "At least one is required for an Activity under a request-origin Project." : "Only users eligible for this workspace are listed."}
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

            <PendingAttachmentsField
              files={attachments.files}
              onFilesChange={attachments.setFiles}
              disabled={saving}
              canUpload={canUploadAttachments}
              unavailableMessage="You don't have permission to attach files to an Activity in this department."
            />

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
          canUploadAttachments={!!canUploadProjectAttachments}
          onCreated={handleProjectCreated}
        />
      )}
    </div>
  );
}
