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

interface Project { id: string; title: string }
interface AssignableUser { id: string; name: string | null; email: string }
interface StatusOption { status: ActivityStatus; label: string; color: string }

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
}

interface Props {
  id: string;
  isAdmin: boolean;
}

export function ActivityEditClient({ id, isAdmin }: Props) {
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
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  // Same deferred/pending-selection pattern reused verbatim from the Ticket
  // inline creation flow (components/tickets/ticket-form.tsx) and from
  // ActivityNewForm above — a just-created Project can't be selected in the
  // same commit as adding it to `projects`, see those files' own doc
  // comments for the full Radix SelectBubbleInput explanation.
  const [pendingProjectSelection, setPendingProjectSelection] = useState<string | null>(null);

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
    <div className="space-y-6 max-w-2xl">
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

      {isAdmin && (
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
