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
import { ActivityDeleteButton } from "@/components/activities/activity-delete-button";
import { ProjectCreateDialog } from "@/components/projects/project-create-dialog";

interface Project { id: string; title: string; projectRequestId: string | null }
interface AssignableUser { id: string; name: string | null; email: string }
interface StatusOption { status: ActivityStatus; label: string; color: string }
// The NEW, universally-required classification (see TaskType in
// prisma/schema.prisma) — no cost of its own.
interface TaskTypeOption { id: string; name: string }
// The RENAMED former "Task Type" (see TaskSubType in prisma/schema.prisma)
// — cost is nullable now; `null` means "no fixed configured cost", never
// treated as 0.
interface TaskSubTypeOption { id: string; name: string; cost: number | null }

/**
 * Shape of GET /api/activities/[id]'s JSON response, as actually consumed
 * by this client. Declared explicitly (rather than treating the fetch
 * result as `any`) so that if a future change to that route ever renames or
 * drops `canCreateProjectInDept`/`canEditActivity`, `tsc` fails loudly instead of
 * the field silently defaulting to `false`/`undefined` at runtime — closing
 * exactly the "response mapping silently drops a field" failure class.
 */
interface ActivityDetailResponse {
  error?: string;
  title?: string;
  description?: string | null;
  projectId?: string | null;
  status?: ActivityStatus;
  priority?: ActivityPriority;
  assignedUsers?: { id: string }[];
  startDate?: string | null;
  dueDate?: string | null;
  progress?: number | null;
  isMilestone?: boolean;
  subDepartmentId?: string | null;
  departmentId?: string | null;
  /** The department actually used to resolve status/progress config — `departmentId` when set, otherwise the app's configured legacy department. See app/api/activities/[id]/route.ts and the final report for why this is required (not `departmentId` directly) to fetch this activity's status options. */
  effectiveDepartmentId?: string | null;
  statusLabel?: string;
  statusColor?: string;
  /** Whether the current user holds project.create in this activity's department — see app/api/activities/[id]/route.ts. A UI hint only; POST /api/projects independently re-checks it. */
  canCreateProjectInDept?: boolean;
  canEditActivity?: boolean;
  /** Whether the current user holds activity.delete here — a SEPARATE, independently-grantable permission from activity.edit (see prisma/seed.ts). Governs the Danger Zone's Delete control. DELETE /api/activities/[id] independently re-checks this; this is only a UI hint. */
  canDeleteActivity?: boolean;
  /** Only present/non-null when projectId is set — carries the parent Project's own projectRequestId, the canonical server-resolved provenance signal (never a client flag). */
  project?: { id: string; title: string; projectRequestId: string | null } | null;
  expectedStartDate?: string | null;
  expectedFinishDate?: string | null;
  /** Server-derived, never editable — see prisma/schema.prisma's ProjectActivity.expectedDays doc comment. */
  expectedDays?: number | null;
  /** Server-derived on the COMPLETED transition, never editable. */
  actualDays?: number | null;
  ownerId?: string | null;
  /** The NEW, universally-required Task Type classification (see TaskType in prisma/schema.prisma). */
  taskTypeId?: string | null;
  /** The RENAMED former "Task Type" (see TaskSubType in prisma/schema.prisma) — request-origin-only, same optional-elsewhere semantics as before. */
  taskSubTypeId?: string | null;
  /** Prisma.Decimal serializes to a STRING over JSON (toJSON()), never a bare number — converted client-side before use. The historical snapshot, never re-read live from the Task Sub Type's current cost. `null` means "no configured cost," never 0. */
  taskSubTypeCost?: string | number | null;
  /** Server-derived (GET /api/activities/[id] via computeActivityFinancials) — taskSubTypeCost × expectedDays. Decimal-as-string over JSON, never stored, never editable. */
  estimatedCost?: string | number | null;
  /** Server-derived — taskSubTypeCost × actualDays (0 unless currently COMPLETED). Never stored, never editable. */
  actualCost?: string | number | null;
}

interface Props {
  id: string;
}

export function ActivityEditClient({ id }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");
  const [status, setStatus] = useState<ActivityStatus>(ActivityStatus.TODO);
  const [priority, setPriority] = useState<ActivityPriority>(ActivityPriority.MEDIUM);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [startDate, setStartDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [progress, setProgress] = useState<number | null>(0);
  const [isMilestone, setIsMilestone] = useState(false);
  const [subDepartments, setSubDepartments] = useState<{ id: string; name: string }[]>([]);
  const [subDepartmentId, setSubDepartmentId] = useState("");
  const [statusOptions, setStatusOptions] = useState<StatusOption[]>([]);
  const [activityDepartmentId, setActivityDepartmentId] = useState<string | null>(null);
  const [canCreateProjectInDept, setCanCreateProjectInDept] = useState(false);
  const [canDeleteActivity, setCanDeleteActivity] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  // Same deferred/pending-selection pattern reused verbatim from the Ticket
  // inline creation flow (components/tickets/ticket-form.tsx) and from
  // ActivityNewForm above — a just-created Project can't be selected in the
  // same commit as adding it to `projects`, see those files' own doc
  // comments for the full Radix SelectBubbleInput explanation.
  const [pendingProjectSelection, setPendingProjectSelection] = useState<string | null>(null);

  // Request-origin-only — shown/editable (optionally; never required on
  // edit, unlike at initial request-origin creation) whenever the
  // CURRENTLY SELECTED project (see isRequestOrigin below, reactive off
  // `projects`/`projectId`, same as ActivityNewForm) itself originates from
  // a Project Request.
  const [expectedStartDate, setExpectedStartDate] = useState("");
  const [expectedFinishDate, setExpectedFinishDate] = useState("");
  const [ownerId, setOwnerId] = useState("");
  // Task Type (NEW, required for every Activity — not just request-origin).
  const [taskTypeId, setTaskTypeId] = useState("");
  const [taskTypes, setTaskTypes] = useState<TaskTypeOption[]>([]);
  // Task Sub Type (RENAMED former "Task Type" — request-origin-only, same
  // optional-elsewhere semantics as before this rename).
  const [taskSubTypeId, setTaskSubTypeId] = useState("");
  const [taskSubTypes, setTaskSubTypes] = useState<TaskSubTypeOption[]>([]);
  // Manual Estimated Cost — only meaningful (and only ever honored
  // server-side) when the currently-selected Task Sub Type has NO
  // configured cost. Pre-filled from this Activity's own existing snapshot
  // once taskSubTypes loads (see the fetch below); cleared whenever the
  // user switches Task Sub Type in this form, so a stale value never
  // silently carries over to a different subtype.
  const [manualEstimatedCost, setManualEstimatedCost] = useState("");
  // Server-derived, read-only display values — never sent back on PATCH.
  const [expectedDays, setExpectedDays] = useState<number | null>(null);
  const [actualDays, setActualDays] = useState<number | null>(null);
  const [estimatedCost, setEstimatedCost] = useState<number | null>(null);
  const [actualCost, setActualCost] = useState<number | null>(null);

  useEffect(() => {
    fetch(`/api/activities/${id}`)
      .then((r) => (r.ok ? (r.json() as Promise<ActivityDetailResponse>) : null))
      .then((activity) => {
        if (activity && !activity.error) {
          setTitle(activity.title ?? "");
          setDescription(activity.description ?? "");
          setProjectId(activity.projectId ?? "");
          setStatus(activity.status ?? ActivityStatus.TODO);
          setPriority(activity.priority ?? ActivityPriority.MEDIUM);
          setSelectedUserIds((activity.assignedUsers ?? []).map((usr: any) => usr.id));
          setStartDate(activity.startDate ? activity.startDate.substring(0, 10) : "");
          setDueDate(activity.dueDate ? activity.dueDate.substring(0, 10) : "");
          setProgress(activity.progress ?? null);
          setIsMilestone(activity.isMilestone ?? false);
          setSubDepartmentId(activity.subDepartmentId ?? "");
          setActivityDepartmentId(activity.departmentId ?? null);
          setCanCreateProjectInDept(activity.canCreateProjectInDept ?? false);
          setCanDeleteActivity(activity.canDeleteActivity ?? false);

          setExpectedStartDate(activity.expectedStartDate ? activity.expectedStartDate.substring(0, 10) : "");
          setExpectedFinishDate(activity.expectedFinishDate ? activity.expectedFinishDate.substring(0, 10) : "");
          setOwnerId(activity.ownerId ?? "");
          setTaskTypeId(activity.taskTypeId ?? "");
          setTaskSubTypeId(activity.taskSubTypeId ?? "");
          setExpectedDays(typeof activity.expectedDays === "number" ? activity.expectedDays : null);
          setActualDays(typeof activity.actualDays === "number" ? activity.actualDays : null);
          setEstimatedCost(activity.estimatedCost !== null && activity.estimatedCost !== undefined ? Number(activity.estimatedCost) : null);
          setActualCost(activity.actualCost !== null && activity.actualCost !== undefined ? Number(activity.actualCost) : null);
          fetch("/api/task-types")
            .then((r) => (r.ok ? r.json() : []))
            .then((t) => setTaskTypes(Array.isArray(t) ? t : []))
            .catch(() => {});
          fetch("/api/task-sub-types")
            .then((r) => (r.ok ? r.json() : []))
            .then((t) => {
              const list: TaskSubTypeOption[] = Array.isArray(t) ? t : [];
              setTaskSubTypes(list);
              // Pre-fill the manual Estimated Cost input with this
              // Activity's own existing snapshot — but ONLY when the
              // currently-selected Task Sub Type genuinely has no
              // configured cost; the configured cost otherwise remains
              // authoritative and this field stays hidden/empty.
              const current = list.find((st) => st.id === activity.taskSubTypeId);
              if (current && current.cost === null && activity.taskSubTypeCost !== null && activity.taskSubTypeCost !== undefined) {
                setManualEstimatedCost(String(Number(activity.taskSubTypeCost)));
              }
            })
            .catch(() => {});

          // Eligible assignees/sub-departments/projects all depend on the
          // activity's own department — fetched once we know it, not in
          // parallel with the activity itself. The Project dropdown must
          // only ever offer projects from this same department (never
          // company-wide) — GET /api/projects already supports this via
          // ?departmentId=, the same scoping buildProjectListWhere applies
          // everywhere else.
          if (activity.departmentId) {
            fetch(`/api/users?assignableFor=activity&departmentId=${activity.departmentId}`)
              .then((r) => (r.ok ? r.json() : []))
              .then((u) => setAssignableUsers(Array.isArray(u) ? u : []));
            fetch(`/api/departments/${activity.departmentId}/sub-departments`)
              .then((r) => (r.ok ? r.json() : []))
              .then((sd) => setSubDepartments(Array.isArray(sd) ? sd : []));
            fetch(`/api/projects?departmentId=${activity.departmentId}&limit=100`)
              .then((r) => (r.ok ? r.json() : null))
              .then((p) => setProjects(Array.isArray(p?.projects) ? p.projects : []));
          } else {
            // Legacy deptless activity — no single department to scope by;
            // falls back to whatever the viewer can already see, same as
            // before (still scoped to their own accessible departments by
            // buildProjectListWhere, never unscoped).
            fetch("/api/users?assignableFor=activity")
              .then((r) => (r.ok ? r.json() : []))
              .then((u) => setAssignableUsers(Array.isArray(u) ? u : []));
            fetch("/api/projects?limit=100")
              .then((r) => (r.ok ? r.json() : null))
              .then((p) => setProjects(Array.isArray(p?.projects) ? p.projects : []));
          }

          // Status options are resolved off the EFFECTIVE department
          // (`effectiveDepartmentId` — `departmentId` when set, otherwise
          // the app's configured legacy department; see the GET route) —
          // deliberately OUTSIDE the if/else above. Gating this fetch on
          // the raw, possibly-null `departmentId` (as the assignees/
          // sub-departments/projects fetches above intentionally still do)
          // meant a legacy Activity (departmentId: null) never fetched its
          // status options at all, leaving this Select permanently empty —
          // the same root cause the Quick Status dropdown had; see the
          // final report. Only ENABLED statuses are offered for selection —
          // but if this activity's CURRENT status has since been disabled,
          // it must still appear (using its own historical label/color,
          // already returned by GET /api/activities/[id] above) so the
          // dropdown doesn't silently drop the activity's real, current
          // value.
          if (activity.effectiveDepartmentId) {
            fetch(`/api/departments/${activity.effectiveDepartmentId}/activity-statuses`)
              .then((r) => (r.ok ? r.json() : []))
              .then((s) => {
                const enabled: StatusOption[] = Array.isArray(s) ? s.map((row: any) => ({ status: row.status, label: row.label, color: row.color })) : [];
                const hasCurrent = enabled.some((o) => o.status === activity.status);
                setStatusOptions(
                  hasCurrent || !activity.status
                    ? enabled
                    : [...enabled, { status: activity.status, label: activity.statusLabel ?? activity.status, color: activity.statusColor ?? "#94a3b8" }]
                );
              });
          }
        }
      })
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (pendingProjectSelection && projects.some((p) => p.id === pendingProjectSelection)) {
      setProjectId(pendingProjectSelection);
      setPendingProjectSelection(null);
    }
  }, [projects, pendingProjectSelection]);

  const handleProjectCreated = (project: { id: string; title: string }) => {
    // Insert + auto-select only — creation and linking are separate
    // operations here. The Activity itself is NOT auto-saved; the user
    // still presses "Save Changes" normally, and if that later fails the
    // newly-created Project is left exactly as-is (never deleted).
    setProjects((prev) => (prev.some((p) => p.id === project.id) ? prev : [...prev, { id: project.id, title: project.title, projectRequestId: null }]));
    setPendingProjectSelection(project.id);
  };

  const toggleUser = (userId: string) => {
    setSelectedUserIds((prev) =>
      prev.includes(userId) ? prev.filter((x) => x !== userId) : [...prev, userId]
    );
  };

  // Reactive off the CURRENTLY SELECTED project in the dropdown (not just
  // the activity's original project) — same derivation as ActivityNewForm,
  // so picking a different, request-origin project mid-edit (a relink)
  // reflects this block immediately too. PATCH /api/activities/[id]
  // independently re-derives/enforces the identical rule server-side for
  // that relink case.
  const selectedProject = projects.find((p) => p.id === projectId);
  const isRequestOrigin = !!selectedProject?.projectRequestId;

  // Same derivation as ActivityNewForm — whether the CURRENTLY SELECTED
  // Task Sub Type has no configured cost, requiring a manual Estimated
  // Cost. PATCH /api/activities/[id] independently re-derives this
  // server-side off the database row; never trusted from the client.
  const selectedTaskSubType = taskSubTypes.find((t) => t.id === taskSubTypeId);
  const taskSubTypeNeedsManualCost = !!selectedTaskSubType && selectedTaskSubType.cost === null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    if (expectedStartDate && expectedFinishDate && new Date(expectedFinishDate) < new Date(expectedStartDate)) {
      toast.error("Expected Finish cannot be before Expected Start.");
      return;
    }
    if (taskSubTypeNeedsManualCost) {
      const parsed = Number(manualEstimatedCost);
      if (!manualEstimatedCost.trim() || !Number.isFinite(parsed) || parsed < 0) {
        toast.error("Enter a valid Estimated Cost — the selected Task Sub Type has no fixed configured cost.");
        return;
      }
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/activities/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description: description || undefined,
          // Explicit null (not undefined) when cleared — undefined is
          // dropped by JSON.stringify, which would silently leave the
          // activity's existing project untouched instead of making it
          // Standalone.
          projectId: projectId || null,
          status,
          priority,
          assignedUserIds: selectedUserIds,
          startDate: isMilestone ? (dueDate || undefined) : (startDate || undefined),
          dueDate: dueDate || undefined,
          // progress is not sent — it's derived server-side from status
          // (per-department configurable, never manually editable).
          isMilestone,
          subDepartmentId: subDepartmentId || null,
          // Task Type (NEW) — required on this route's own schema whenever
          // the key is present at all, so only ever sent when there's a
          // real selection (never `null`/empty — that would just fail
          // validation). Omitted when blank (a legacy Activity that never
          // had one yet and the user hasn't picked one in THIS edit) so an
          // otherwise-unrelated edit is never forced to backfill it.
          taskTypeId: taskTypeId || undefined,
          // Task Sub Type (RENAMED former "Task Type") — optional on edit
          // (unlike initial request-origin creation, which stays strictly
          // required — see createActivitySchema is NOT weakened). Always
          // sent as a full snapshot: an empty field becomes an explicit
          // `null` ("clear it"), never `undefined` ("leave untouched") and
          // never left to collapse to 0/NaN. Sent whenever the block is
          // relevant (current OR newly-selected project is request-origin)
          // so a relink that fills in the metadata in the same request
          // works; otherwise omitted entirely so a normal/manual Project's
          // Activity edit never even mentions these keys.
          ...(isRequestOrigin || expectedStartDate || expectedFinishDate || ownerId || taskSubTypeId
            ? {
                expectedStartDate: expectedStartDate || null,
                expectedFinishDate: expectedFinishDate || null,
                ownerId: ownerId || null,
                taskSubTypeId: taskSubTypeId || null,
                // Only meaningful when the selected Task Sub Type has no
                // configured cost — the server independently re-derives
                // this and silently ignores it otherwise (the configured
                // cost always wins). Resent even when unchanged, same
                // convention as taskSubTypeId above; the server's own
                // re-snapshot is idempotent when the value hasn't moved.
                ...(taskSubTypeNeedsManualCost ? { manualEstimatedCost: Number(manualEstimatedCost) } : {}),
              }
            : {}),
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to update activity");
      }
      toast.success("Activity updated");
      router.push(`/activities/${id}`);
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update activity");
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    // Wider than a plain form (max-w-4xl) — same convention already used by
    // the request-origin "New Project" setup flow
    // (app/(main)/projects/new/page.tsx) for the same reason: this form
    // carries enough fields (including the conditional Project Request
    // Setup block) that max-w-2xl left a large, visually dead blank area
    // on anything wider than a small laptop screen.
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/activities" className="hover:text-foreground">Activities</Link>
        <ChevronRight className="h-4 w-4" />
        <Link href={`/activities/${id}`} className="hover:text-foreground truncate max-w-[200px]">
          {title}
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground font-medium">Edit</span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Edit Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title">Title *</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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

            {/* Project (with its inline "New" button) and Sub-Department
                grouped in one responsive row — both are
                classification/assignment selects for this Activity.
                Column count adapts to whether Sub-Department is actually
                rendered, so Project never ends up sharing a row with a
                visually empty trailing cell. */}
            <div className={`grid grid-cols-1 gap-4 ${subDepartments.length > 0 ? "sm:grid-cols-2" : ""}`}>
              <div className="space-y-2">
                <Label>Project</Label>
                <div className="flex gap-1.5">
                  <Select value={projectId || ""} onValueChange={setProjectId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Standalone" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">Standalone</SelectItem>
                      {projects.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.title}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 gap-1"
                    disabled={!activityDepartmentId || !canCreateProjectInDept}
                    title={
                      !activityDepartmentId
                        ? "Select a department first."
                        : !canCreateProjectInDept
                        ? "You don't have permission to create projects in this department."
                        : undefined
                    }
                    onClick={() => setProjectDialogOpen(true)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    New
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Only projects in this activity&apos;s department are listed.
                </p>
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
            </div>

            <div className="space-y-2">
              <Label htmlFor="task-type">
                Task Type <span className="text-destructive">*</span>
              </Label>
              <Select value={taskTypeId || "__none__"} onValueChange={(v) => setTaskTypeId(v === "__none__" ? "" : v)}>
                <SelectTrigger id="task-type">
                  <SelectValue placeholder="Select a Task Type…" />
                </SelectTrigger>
                <SelectContent>
                  {/* "__none__" only ever appears for a legacy Activity that
                      predates this field — picking it keeps taskTypeId
                      omitted from the PATCH body (an unrelated edit is
                      never forced to backfill it); choosing a real Task
                      Type here is how such an Activity gets one. */}
                  {!taskTypeId && <SelectItem value="__none__">None (legacy)</SelectItem>}
                  {taskTypes.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Request-origin-only — only ever shown for an Activity whose
                (current or newly-selected) project originates from a
                Project Request. Every field here is OPTIONAL on edit
                (unlike at initial creation, which stays strictly
                required). */}
            {isRequestOrigin && (
              <div className="space-y-4 rounded-lg border p-4 bg-muted/20">
                <div>
                  <h3 className="text-sm font-semibold">Project Request Setup</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">Metadata from this Activity's request-origin Project.</p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="expected-start">Expected Start</Label>
                    <Input id="expected-start" type="date" value={expectedStartDate} onChange={(e) => setExpectedStartDate(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="expected-finish">Expected Finish</Label>
                    <Input id="expected-finish" type="date" value={expectedFinishDate} onChange={(e) => setExpectedFinishDate(e.target.value)} />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="expected-days">Expected Days</Label>
                    <Input
                      id="expected-days"
                      type="text"
                      inputMode="none"
                      readOnly
                      aria-readonly="true"
                      tabIndex={-1}
                      value={expectedDays !== null ? `${expectedDays} day${expectedDays === 1 ? "" : "s"}` : ""}
                      placeholder="Not set"
                      className="cursor-default bg-muted/40"
                    />
                    <p className="text-xs text-muted-foreground">Recalculated from Expected Start/Finish on save — not directly editable.</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="actual-days">Actual Days</Label>
                    <Input
                      id="actual-days"
                      type="text"
                      inputMode="none"
                      readOnly
                      aria-readonly="true"
                      tabIndex={-1}
                      value={actualDays !== null ? `${actualDays} day${actualDays === 1 ? "" : "s"}` : ""}
                      placeholder="Not set until completion"
                      className="cursor-default bg-muted/40"
                    />
                    <p className="text-xs text-muted-foreground">Set automatically when this Activity is completed — not directly editable.</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="estimated-cost">Estimated Cost</Label>
                    <Input
                      id="estimated-cost"
                      type="text"
                      inputMode="none"
                      readOnly
                      aria-readonly="true"
                      tabIndex={-1}
                      value={estimatedCost !== null ? `${estimatedCost.toFixed(2)} EUR` : ""}
                      placeholder="Not set"
                      className="cursor-default bg-muted/40"
                    />
                    <p className="text-xs text-muted-foreground">Task Sub Type cost × Expected Days. Calculated automatically.</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="actual-cost">Actual Cost</Label>
                    <Input
                      id="actual-cost"
                      type="text"
                      inputMode="none"
                      readOnly
                      aria-readonly="true"
                      tabIndex={-1}
                      value={actualCost !== null ? `${actualCost.toFixed(2)} EUR` : ""}
                      placeholder="Not set until completion"
                      className="cursor-default bg-muted/40"
                    />
                    <p className="text-xs text-muted-foreground">Task Sub Type cost × Actual Days. Clears when reopened.</p>
                  </div>
                </div>

                {/* Task Sub Type and Owner grouped in one responsive row —
                    both are simple selects. Task Sub Type can grow taller
                    when its conditional manual-cost sub-field appears;
                    Owner's column just has extra space below it then,
                    the same as any other uneven-height grid row. */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Task Sub Type</Label>
                    <Select
                      value={taskSubTypeId || "__none__"}
                      onValueChange={(v) => {
                        setTaskSubTypeId(v === "__none__" ? "" : v);
                        // Switching Task Sub Type always invalidates any
                        // previously-entered/pre-filled manual Estimated
                        // Cost — it must never silently carry over to a
                        // different subtype (fixed-cost or another
                        // null-cost one).
                        setManualEstimatedCost("");
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">None</SelectItem>
                        {taskSubTypes.map((t) => (
                          <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {/* Informational preview of what will be (re-)snapshotted
                        if this Activity is saved — never the authoritative
                        value; the server independently re-derives it from
                        the database. */}
                    {selectedTaskSubType && selectedTaskSubType.cost !== null && (
                      <p className="text-xs text-muted-foreground">Cost: {selectedTaskSubType.cost.toFixed(2)} EUR</p>
                    )}
                    {taskSubTypeNeedsManualCost && (
                      <div className="space-y-2 pt-1">
                        <Label htmlFor="manual-estimated-cost">
                          Estimated Cost <span className="text-destructive">*</span>
                        </Label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">€</span>
                          <Input
                            id="manual-estimated-cost"
                            type="number"
                            min="0"
                            step="0.01"
                            className="pl-7"
                            placeholder="0.00"
                            value={manualEstimatedCost}
                            onChange={(e) => setManualEstimatedCost(e.target.value)}
                          />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          This Task Sub Type has no fixed configured cost — enter the estimated cost for this Activity.
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label>Owner</Label>
                    <Select value={ownerId || "__none__"} onValueChange={(v) => setOwnerId(v === "__none__" ? "" : v)}>
                      <SelectTrigger>
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">None</SelectItem>
                        {assignableUsers.map((u) => (
                          <SelectItem key={u.id} value={u.id}>{u.name ?? u.email}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label>{isRequestOrigin ? "Related Users" : "Assigned Users"}</Label>
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

            <div className="flex items-start gap-3 p-3 rounded-md border bg-muted/30">
              <input
                type="checkbox"
                id="isMilestone"
                className="h-4 w-4 mt-0.5 rounded"
                checked={isMilestone}
                onChange={(e) => setIsMilestone(e.target.checked)}
              />
              <div>
                <Label htmlFor="isMilestone" className="cursor-pointer font-medium">Mark as Milestone</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Milestones appear as a diamond marker on the Gantt timeline at a single date.
                </p>
              </div>
            </div>

            {isMilestone ? (
              <div className="space-y-2">
                <Label htmlFor="dueDate">Milestone Date</Label>
                <Input
                  id="dueDate"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
            )}

            {!isMilestone && (
              <div className="space-y-2">
                <Label>Progress</Label>
                {progress === null ? (
                  <p className="text-sm text-amber-700">
                    Configuration required — no progress percentage is configured for this status in this department.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {progress}% — calculated automatically from status
                  </p>
                )}
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save Changes
              </Button>
              <Button type="button" variant="outline" onClick={() => router.back()}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {activityDepartmentId && (
        <ProjectCreateDialog
          open={projectDialogOpen}
          onOpenChange={setProjectDialogOpen}
          departmentId={activityDepartmentId}
          onCreated={handleProjectCreated}
        />
      )}

      {canDeleteActivity && (
        <Card className="border-destructive/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm text-destructive">Danger Zone</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-3">
              Permanently delete this activity. This action cannot be undone.
            </p>
            <ActivityDeleteButton
              activityId={id}
              activityTitle={title}
              projectId={projectId || null}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
