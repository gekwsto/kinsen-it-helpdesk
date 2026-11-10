"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UserAvatarTooltip } from "@/components/shared/user-avatar-tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDate } from "@/lib/utils";
import { ChevronRight, Loader2, CheckCircle2, Circle, Pencil, Ticket, GitMerge, Trash2, Plus, Users, Calendar, Wallet } from "lucide-react";
import { ActivityStatus, ActivityPriority } from "@prisma/client";
import { formatTicketNumber } from "@/lib/utils";
import { ActivityDeleteButton } from "@/components/activities/activity-delete-button";
import { InlineActivityDateField } from "@/components/activities/inline-activity-date-field";
import { toggleActivityComplete } from "@/components/activities/toggle-activity-complete";
import { ActivityQuickStatus, type ActivityStatusUpdate } from "@/components/activities/activity-quick-status";
import type { QuickStatusOption } from "@/components/status/quick-status-select";
import { StatusBadge } from "@/components/shared/activity-status-badge";
import { resolveActivityUserRoles } from "@/lib/activities/activity-user-roles";
import { EntityNotes } from "@/components/notes/entity-notes";
import { EntityRelatedLinks } from "@/components/related-links/entity-related-links";
import type { Note } from "@/components/notes/types";
import { EntityAttachments } from "@/components/attachments/entity-attachments";

const PRIORITY_COLORS: Record<ActivityPriority, string> = {
  LOW: "bg-green-50 text-green-700",
  MEDIUM: "bg-yellow-50 text-yellow-700",
  HIGH: "bg-orange-50 text-orange-700",
  URGENT: "bg-red-50 text-red-700",
};

interface Activity {
  id: string;
  title: string;
  description?: string | null;
  status: ActivityStatus;
  /** This activity's department-resolved status display label — see lib/services/activity-status-config.ts. */
  statusLabel: string;
  /** This activity's department-resolved status color (#RRGGBB). */
  statusColor: string;
  priority: ActivityPriority;
  /** null means no ActivityProgressConfig row is configured/enabled for this activity's department+status — see lib/activities/activity-progress.ts. Never rendered as 0%. */
  progress: number | null;
  progressConfigError?: { reason: "missing" | "disabled" } | null;
  isCompleted: boolean;
  completedAt?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
  createdAt: string;
  project?: { id: string; title: string; projectRequestId?: string | null } | null;
  assignedUsers: { id: string; name?: string | null; email: string; image?: string | null }[];
  department?: { id: string; name: string } | null;
  // Request-origin-only — only ever populated for an Activity whose parent
  // Project itself originates from a Project Request (project.projectRequestId
  // non-null). See app/api/activities/[id]/route.ts.
  expectedStartDate?: string | null;
  expectedFinishDate?: string | null;
  expectedDays?: number | null;
  actualDays?: number | null;
  owner?: { id: string; name: string | null; email: string; image?: string | null } | null;
  /** The NEW, universally-required Task Type classification (see TaskType in prisma/schema.prisma) — populated for every Activity, not just request-origin ones. */
  taskType?: { id: string; name: string } | null;
  /** The RENAMED former "Task Type" (see TaskSubType in prisma/schema.prisma) — request-origin-only, same optional-elsewhere semantics as before. */
  taskSubType?: { id: string; name: string } | null;
  /** Prisma.Decimal serializes to a STRING over JSON — converted with Number() before display. `null` means "no configured cost," never 0. */
  taskSubTypeCost?: string | number | null;
  /** Server-derived (GET /api/activities/[id] via computeActivityFinancials) — taskSubTypeCost × expectedDays. Never stored. */
  estimatedCost?: string | number | null;
  /** Server-derived — taskSubTypeCost × actualDays (0 unless currently COMPLETED). Never stored. */
  actualCost?: string | number | null;
  /** Whether the current user holds activity.edit here — governs the Notes composer AND the quick-status dropdown. POST /api/activities/[id]/notes and PATCH /api/activities/[id] independently re-check this; this is only a UI hint. */
  canEditActivity?: boolean;
  /** Whether the current user holds activity.delete here — a SEPARATE, independently-grantable permission from activity.edit (see prisma/seed.ts). Governs the Delete control. DELETE /api/activities/[id] independently re-checks this; this is only a UI hint. */
  canDeleteActivity?: boolean;
  /**
   * The department actually used to resolve this Activity's status/progress
   * config — `departmentId` when set, otherwise the app's configured legacy
   * department (see app/api/activities/[id]/route.ts). A legacy Activity
   * (departmentId: null) still needs a REAL department id here to fetch its
   * status options from; using the raw (possibly null) `departmentId` for
   * that fetch was the root cause of a permanently-empty Quick Status
   * dropdown for such Activities.
   */
  effectiveDepartmentId?: string | null;
}

interface Attachment {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: string;
  uploadedBy?: { id: string; name?: string | null; email: string } | null;
}

interface RelatedTicket {
  id: string;
  ticketNumber: number;
  title: string;
  status: { id: string; name: string; color: string };
}

interface DepActivity {
  id: string;
  title: string;
  status: string;
}

interface Dependency {
  id: string;
  predecessorId: string;
  successorId: string;
  type: string;
  predecessor: DepActivity;
  successor: DepActivity;
}

interface ActivityOption {
  id: string;
  title: string;
}

const DEP_TYPE_LABELS: Record<string, string> = {
  FINISH_TO_START:  "Finish → Start (FS)",
  START_TO_START:   "Start → Start (SS)",
  FINISH_TO_FINISH: "Finish → Finish (FF)",
  START_TO_FINISH:  "Start → Finish (SF)",
};

interface Props {
  id: string;
  // Gates the Dependencies section only (add/remove predecessor, fetching
  // the full activity list for the picker) — see
  // activity.dependency.manage in app/api/dependencies/route.ts. Despite
  // the name, this is unrelated to any OTHER admin-only behavior on this
  // page (there is none today).
  canManageDependencies: boolean;
}

export function ActivityDetailClient({ id, canManageDependencies }: Props) {
  const router = useRouter();
  const [activity, setActivity] = useState<Activity | null>(null);
  const [relatedTickets, setRelatedTickets] = useState<RelatedTicket[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [statusOptions, setStatusOptions] = useState<QuickStatusOption[]>([]);
  /**
   * Distinct from `statusOptions.length === 0` — an EMPTY array can mean
   * "still loading", "the request failed", or "the department genuinely
   * has zero configured statuses". QuickStatusSelect renders a different,
   * explicit message for each rather than a silently blank menu (see the
   * regression this caused: a real fetch failure and a real empty list
   * were previously visually indistinguishable from each other).
   */
  const [statusOptionsState, setStatusOptionsState] = useState<"loading" | "ready" | "error">("loading");
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);

  // Which of the 4 inline Timeline date fields (startDate/dueDate/
  // expectedStartDate/expectedFinishDate) currently has a save in flight —
  // shared across all 4 so a second field can never be edited (let alone
  // saved) while another one's PATCH is still in flight, which would
  // otherwise let two concurrent responses race to overwrite `activity`.
  const [savingDateField, setSavingDateField] = useState<string | null>(null);

  // Dependencies
  const [dependencies, setDependencies] = useState<Dependency[]>([]);
  const [allActivities, setAllActivities] = useState<ActivityOption[]>([]);
  const [newPredId, setNewPredId] = useState("");
  const [newDepType, setNewDepType] = useState("FINISH_TO_START");
  const [addingDep, setAddingDep] = useState(false);
  const [removingDepId, setRemovingDepId] = useState<string | null>(null);

  useEffect(() => {
    // Reset at the START of every load (not just the initial mount) — this
    // component has no `key={id}`, so navigating between two DIFFERENT
    // activities via an in-app <Link> (client-side routing) reuses the
    // SAME component instance and would otherwise leave the PREVIOUS
    // activity's status/statusOptions/notes visible/stale for the entire
    // window the new fetches are in flight, instead of the loading state.
    setLoading(true);
    setActivity(null);
    setStatusOptions([]);
    setStatusOptionsState("loading");
    setAttachments([]);
    const fetches: Promise<any>[] = [
      fetch(`/api/activities/${id}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/tickets?activityId=${id}&limit=10`)
        .then((r) => (r.ok ? r.json() : { tickets: [] }))
        .then((d) => d.tickets ?? []),
      fetch(`/api/dependencies?activityId=${id}`).then((r) => (r.ok ? r.json() : [])),
      fetch(`/api/activities/${id}/notes`).then((r) => (r.ok ? r.json() : [])),
      fetch(`/api/activities/${id}/attachments`).then((r) => (r.ok ? r.json() : [])),
    ];
    if (canManageDependencies) {
      fetches.push(fetch("/api/activities?limit=200").then((r) => (r.ok ? r.json() : [])));
    }
    Promise.all(fetches)
      .then(([act, tickets, deps, fetchedNotes, fetchedAttachments, acts]) => {
        setActivity(act);
        setRelatedTickets(tickets);
        setDependencies(Array.isArray(deps) ? deps : []);
        setNotes(Array.isArray(fetchedNotes) ? fetchedNotes : []);
        setAttachments(Array.isArray(fetchedAttachments) ? fetchedAttachments : []);
        if (acts) {
          const list = (Array.isArray(acts) ? acts : []) as ActivityOption[];
          setAllActivities(list.filter((a: ActivityOption) => a.id !== id));
        }

        // Status options depend on the activity's EFFECTIVE department
        // (`effectiveDepartmentId` — `departmentId` when set, otherwise the
        // app's configured legacy department; see the GET route). Using the
        // raw, possibly-null `departmentId` here was the root cause of a
        // permanently-empty Quick Status dropdown for legacy Activities
        // (departmentId: null) — this `if` was simply never entered for
        // them, so `statusOptions` stayed `[]` forever, and the dropdown
        // opened with nothing to render (the trigger still showed the
        // correct current status independently, since that comes from
        // `activity.statusLabel` directly — the two are unrelated, which is
        // exactly what made this gap hard to notice).
        //
        // Same department-scoped, ENABLED-only source (GET
        // /api/departments/[id]/activity-statuses, backed by
        // getEnabledActivityStatusesForDepartment) the Edit Activity form
        // already uses for this exact dropdown. The activity's CURRENT
        // status is always included even if it's since been disabled for
        // NEW selections — same "never make the entity's real value
        // un-displayable" merge rule activity-edit-client.tsx already
        // applies, not a new heuristic.
        if (act?.effectiveDepartmentId) {
          fetch(`/api/departments/${act.effectiveDepartmentId}/activity-statuses`)
            .then((r) => {
              if (!r.ok) throw new Error(`activity-statuses fetch failed: ${r.status}`);
              return r.json();
            })
            .then((rows) => {
              const enabled: QuickStatusOption[] = Array.isArray(rows)
                ? rows.map((row: any) => ({ id: row.status, label: row.label, color: row.color }))
                : [];
              const hasCurrent = enabled.some((o) => o.id === act.status);
              setStatusOptions(
                hasCurrent || !act.status
                  ? enabled
                  : [...enabled, { id: act.status, label: act.statusLabel ?? act.status, color: act.statusColor }]
              );
              setStatusOptionsState("ready");
            })
            .catch(() => setStatusOptionsState("error"));
        } else {
          // No department could be resolved at all (not even the legacy
          // fallback is configured) — a real, reportable configuration gap,
          // never silently treated as "zero statuses available".
          setStatusOptionsState("error");
        }
      })
      .finally(() => setLoading(false));
  }, [id, canManageDependencies]);

  const handleStatusChanged = (updated: ActivityStatusUpdate) => {
    setActivity((prev) =>
      prev
        ? {
            ...prev,
            status: updated.status as ActivityStatus,
            statusLabel: updated.statusLabel,
            statusColor: updated.statusColor,
            progress: updated.progress,
            progressConfigError: null,
            isCompleted: updated.isCompleted,
            completedAt: updated.completedAt,
            actualDays: updated.actualDays,
            actualCost: updated.actualCost,
          }
        : prev
    );
  };

  const addDependency = async () => {
    if (!newPredId) { toast.error("Select a predecessor activity"); return; }
    setAddingDep(true);
    try {
      const res = await fetch("/api/dependencies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ predecessorId: newPredId, successorId: id, type: newDepType }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Failed to add dependency"); return; }
      setDependencies((prev) => [...prev, data]);
      setNewPredId("");
      toast.success("Dependency added");
    } catch {
      toast.error("Failed to add dependency");
    } finally {
      setAddingDep(false);
    }
  };

  const removeDependency = async (depId: string) => {
    setRemovingDepId(depId);
    try {
      const res = await fetch(`/api/dependencies/${depId}`, { method: "DELETE" });
      if (!res.ok) { toast.error("Failed to remove dependency"); return; }
      setDependencies((prev) => prev.filter((d) => d.id !== depId));
      toast.success("Dependency removed");
    } catch {
      toast.error("Failed to remove dependency");
    } finally {
      setRemovingDepId(null);
    }
  };

  const toggleComplete = async () => {
    if (!activity) return;
    setToggling(true);
    try {
      const { isCompleted, status, progress, actualDays, actualCost } = await toggleActivityComplete(id, activity.isCompleted);
      setActivity((prev) => (prev ? { ...prev, isCompleted, status: status as ActivityStatus, progress, actualDays, actualCost } : prev));
      toast.success(isCompleted ? "Activity completed!" : "Activity reopened");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update activity");
    } finally {
      setToggling(false);
    }
  };

  // THE one place every inline Timeline date edit calls through — PATCH
  // /api/activities/[id] with ONLY the single field that changed, the exact
  // same endpoint/permission/validation the Edit Activity form's own
  // Start/Due/Expected Start/Expected Finish fields already go through, no
  // parallel update path. The response is the FULL updated Activity (same
  // shape GET returns), so applying its date/expectedDays/actualDays/cost
  // fields back onto local state picks up every server-side side effect
  // (expectedDays recalculation, etc.) without a second fetch or
  // router.refresh(). Never sends `status`/`isCompleted`, so the
  // COMPLETED-transition boundary in the route never fires from a plain
  // date edit — isCompleted/completedAt/actualDays are only ever touched
  // there by a genuine status transition, exactly preserving "a date edit
  // on an already-completed Activity never retroactively changes actualDays".
  const updateActivityDate = async (
    field: "startDate" | "dueDate" | "expectedStartDate" | "expectedFinishDate",
    value: string | null
  ): Promise<boolean> => {
    setSavingDateField(field);
    try {
      const res = await fetch(`/api/activities/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      const resData = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Surfaces the route's OWN validation message verbatim (e.g.
        // "Start date cannot be after due date.", "Expected Finish cannot
        // be before Expected Start.") — never a client-side re-derivation
        // of the same business rule.
        toast.error(typeof resData.error === "string" ? resData.error : "Failed to update date");
        return false;
      }
      setActivity((prev) =>
        prev
          ? {
              ...prev,
              startDate: resData.startDate ?? null,
              dueDate: resData.dueDate ?? null,
              expectedStartDate: resData.expectedStartDate ?? null,
              expectedFinishDate: resData.expectedFinishDate ?? null,
              expectedDays: resData.expectedDays ?? null,
              actualDays: resData.actualDays ?? null,
              estimatedCost: resData.estimatedCost,
              actualCost: resData.actualCost,
            }
          : prev
      );
      toast.success("Date updated");
      return true;
    } catch {
      toast.error("Failed to update date");
      return false;
    } finally {
      setSavingDateField(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!activity) {
    return <div>Activity not found</div>;
  }

  return (
    // No max-width cap (previously max-w-3xl, then max-w-6xl) — a fixed
    // Tailwind cap always clamps at SOME fixed px value, which is exactly
    // the thing that kept wasting space on anything wider than it (1152px
    // at max-w-6xl: measured 464px of unused width at a 1920px viewport,
    // 1104px at 2560px). Fills whatever <main> actually gives it instead
    // (page padding is <main>'s own p-4 sm:p-6 in app/(main)/layout.tsx,
    // untouched here) — the lg:grid-cols-3 grid (header/Project Request
    // Setup + a Dependencies/Related Tickets right rail) distributes that
    // width proportionally on its own.
    <div className="space-y-6">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/activities" className="hover:text-foreground">Activities</Link>
        {activity.project && (
          <>
            <ChevronRight className="h-4 w-4" />
            <Link href={`/projects/${activity.project.id}`} className="hover:text-foreground">
              {activity.project.title}
            </Link>
          </>
        )}
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground font-medium">{activity.title}</span>
      </div>

      {/* Core activity info (left, wider) beside a "relationships" rail
          (right: Dependencies + Related Tickets — both track this
          Activity's connections to OTHER records, grouped together the
          same way the Project detail page groups its own "at a glance"
          cards). Attachments/Notes/Related Links are chronological/list
          content that can grow arbitrarily tall, so they sit full-width
          below the grid instead of being squeezed into either column —
          see that section's own comment further down. */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <button onClick={toggleComplete} disabled={toggling} className="mt-1 flex-shrink-0">
                    {activity.isCompleted ? (
                      <CheckCircle2 className="h-5 w-5 text-green-600" />
                    ) : (
                      <Circle className="h-5 w-5 text-muted-foreground hover:text-primary" />
                    )}
                  </button>
                  <div>
                    <CardTitle
                      className={`text-xl ${activity.isCompleted ? "line-through text-muted-foreground" : ""}`}
                    >
                      {activity.title}
                    </CardTitle>
                    <div className="flex items-center gap-2 mt-2">
                      <StatusBadge label={activity.statusLabel} color={activity.statusColor} />
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded-full ${PRIORITY_COLORS[activity.priority]}`}
                      >
                        {activity.priority}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => router.push(`/activities/${id}/edit`)}
                  >
                    <Pencil className="h-3.5 w-3.5 mr-1.5" />
                    Edit
                  </Button>
                  <ActivityQuickStatus
                    activityId={id}
                    currentStatus={activity.status}
                    currentStatusLabel={activity.statusLabel}
                    currentStatusColor={activity.statusColor}
                    statuses={statusOptions}
                    optionsState={statusOptionsState}
                    canEdit={activity.canEditActivity ?? false}
                    onChanged={handleStatusChanged}
                  />
                  {activity.canDeleteActivity && (
                    <ActivityDeleteButton
                      activityId={id}
                      activityTitle={activity.title}
                      projectId={activity.project?.id ?? null}
                    />
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {activity.description && (
                <div>
                  <p className="text-sm text-muted-foreground mb-1">Description</p>
                  <p className="text-sm whitespace-pre-wrap">{activity.description}</p>
                </div>
              )}
              <Separator />
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-xs text-muted-foreground">Progress</p>
                  <div className="text-right">
                    {activity.progress === null ? (
                      <p className="text-xs font-medium text-amber-700">Configuration required</p>
                    ) : (
                      <>
                        <span className="text-xs font-medium">{activity.progress}%</span>
                        <p className="text-[10px] text-muted-foreground">
                          Calculated automatically from status
                        </p>
                      </>
                    )}
                  </div>
                </div>
                {activity.progress === null ? (
                  <p className="text-[11px] text-amber-700">
                    No progress percentage is configured for status &quot;{activity.statusLabel}&quot; in this department. Ask an admin to configure it under Activity Progress.
                  </p>
                ) : (
                  <div className="h-1.5 bg-muted rounded-full">
                    <div
                      className="h-1.5 bg-primary rounded-full transition-all"
                      style={{ width: `${activity.progress}%` }}
                    />
                  </div>
                )}
              </div>
              <Separator />

              {/* General Information */}
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">General Information</p>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Project</p>
                    {activity.project ? (
                      <Link
                        href={`/projects/${activity.project.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {activity.project.title}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground italic">Standalone</span>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Task Type</p>
                    {/* "Not set" only ever appears for a legacy Activity created
                        before this classification existed — never fabricated. */}
                    <p className="font-medium">{activity.taskType?.name ?? "Not set"}</p>
                  </div>
                  {activity.department && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Department</p>
                      <p className="font-medium">{activity.department.name}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* People / Related Users — the exact two user relations
                  canonically loaded for an Activity (see GET
                  /api/activities/[id]'s own `include`): assignedUsers
                  (every Activity) and owner (request-origin only). No third
                  relation invented — Owner still only renders when this
                  Activity's parent Project actually originates from a
                  Project Request, same gating the old "Project Request
                  Setup" card used for this exact field. */}
              {(activity.assignedUsers.length > 0 || activity.project?.projectRequestId) && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                    <Users className="h-3 w-3" /> People
                  </p>
                  <TooltipProvider delayDuration={200}>
                    <div className="grid gap-3 sm:grid-cols-2 text-sm">
                      {activity.assignedUsers.length > 0 && (
                        <div>
                          <p className="text-xs text-muted-foreground mb-1.5">Assigned To</p>
                          <div className="flex flex-wrap gap-2">
                            {activity.assignedUsers.map((u) => (
                              <div key={u.id} className="flex items-center gap-1.5">
                                <UserAvatarTooltip
                                  user={u}
                                  roles={resolveActivityUserRoles(activity, u.id)}
                                  avatarClassName="h-5 w-5"
                                  fallbackClassName="text-[9px]"
                                />
                                <span className="font-medium text-sm">{u.name ?? u.email}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {activity.project?.projectRequestId && (
                        <div>
                          <p className="text-xs text-muted-foreground mb-1.5">Owner</p>
                          {activity.owner ? (
                            <div className="flex items-center gap-1.5">
                              <UserAvatarTooltip
                                user={activity.owner}
                                roles={resolveActivityUserRoles(activity, activity.owner.id)}
                                avatarClassName="h-5 w-5"
                                fallbackClassName="text-[9px]"
                              />
                              <span className="font-medium">{activity.owner.name ?? activity.owner.email}</span>
                            </div>
                          ) : (
                            <p className="font-medium">Not set</p>
                          )}
                        </div>
                      )}
                    </div>
                  </TooltipProvider>
                </div>
              )}

              {/* Timeline — Start/Due Date exist on any Activity; Expected
                  Start/Finish/Days + Actual Days are request-origin-only,
                  same gating as before. All 4 dates (Expected Days/Actual
                  Days are server-derived, never directly editable) are
                  inline-editable for a user with activity.edit — see
                  InlineActivityDateField and updateActivityDate above.
                  A date-less field (Start/Due Date) still only appears to a
                  READ-ONLY viewer when it's actually set, exactly as
                  before; an EDITOR also sees it when unset, as "Not set",
                  so there's a way to set one in the first place — same
                  reasoning extends to the whole section itself staying
                  visible for an editor even on a bare Activity with no
                  dates/project request yet. */}
              {(activity.startDate || activity.dueDate || activity.project?.projectRequestId || activity.canEditActivity) && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                    <Calendar className="h-3 w-3" /> Timeline
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
                    {(activity.startDate || activity.canEditActivity) && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1">Start Date</p>
                        <InlineActivityDateField
                          value={activity.startDate ?? null}
                          canEdit={activity.canEditActivity ?? false}
                          disabled={savingDateField !== null && savingDateField !== "startDate"}
                          isSaving={savingDateField === "startDate"}
                          onSave={(value) => updateActivityDate("startDate", value)}
                        />
                      </div>
                    )}
                    {(activity.dueDate || activity.canEditActivity) && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1">Due Date</p>
                        <InlineActivityDateField
                          value={activity.dueDate ?? null}
                          canEdit={activity.canEditActivity ?? false}
                          disabled={savingDateField !== null && savingDateField !== "dueDate"}
                          isSaving={savingDateField === "dueDate"}
                          onSave={(value) => updateActivityDate("dueDate", value)}
                        />
                      </div>
                    )}
                    {activity.project?.projectRequestId && (
                      <>
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">Expected Start</p>
                          <InlineActivityDateField
                            value={activity.expectedStartDate ?? null}
                            canEdit={activity.canEditActivity ?? false}
                            disabled={savingDateField !== null && savingDateField !== "expectedStartDate"}
                            isSaving={savingDateField === "expectedStartDate"}
                            onSave={(value) => updateActivityDate("expectedStartDate", value)}
                          />
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">Expected Finish</p>
                          <InlineActivityDateField
                            value={activity.expectedFinishDate ?? null}
                            canEdit={activity.canEditActivity ?? false}
                            disabled={savingDateField !== null && savingDateField !== "expectedFinishDate"}
                            isSaving={savingDateField === "expectedFinishDate"}
                            onSave={(value) => updateActivityDate("expectedFinishDate", value)}
                          />
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">Expected Days</p>
                          <p className="font-medium">{typeof activity.expectedDays === "number" ? `${activity.expectedDays} day(s)` : "Not set"}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">Actual Days</p>
                          <p className="font-medium">{typeof activity.actualDays === "number" ? `${activity.actualDays} day(s)` : "Not set until completion"}</p>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Financial / Setup — request-origin-only, same gating as
                  the old "Project Request Setup" card. */}
              {activity.project?.projectRequestId && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                    <Wallet className="h-3 w-3" /> Financial Information
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Task Sub Type</p>
                      <p className="font-medium">
                        {activity.taskSubType?.name ?? "Not set"}
                        {/* `null` (no configured cost) is simply never shown — never displayed as 0.00. */}
                        {activity.taskSubTypeCost !== null && activity.taskSubTypeCost !== undefined && (
                          <span className="text-muted-foreground font-normal"> — {Number(activity.taskSubTypeCost).toFixed(2)} EUR</span>
                        )}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Estimated Cost</p>
                      <p className="font-medium">{activity.estimatedCost !== null && activity.estimatedCost !== undefined ? `${Number(activity.estimatedCost).toFixed(2)} EUR` : "0.00 EUR"}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Actual Cost</p>
                      <p className="font-medium">{activity.actualCost !== null && activity.actualCost !== undefined ? `${Number(activity.actualCost).toFixed(2)} EUR` : "0.00 EUR"}</p>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          {/* Dependencies */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <GitMerge className="h-4 w-4" />
                Dependencies ({dependencies.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {dependencies.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-2">
                  No dependencies defined.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {dependencies.map((dep) => {
                    const isPred = dep.predecessorId === id;
                    const other  = isPred ? dep.successor : dep.predecessor;
                    const label  = DEP_TYPE_LABELS[dep.type] ?? dep.type;
                    return (
                      <div key={dep.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded ${isPred ? "bg-indigo-50 text-indigo-700" : "bg-amber-50 text-amber-700"}`}>
                            {isPred ? "blocks" : "blocked by"}
                          </span>
                          <Link href={`/activities/${other.id}`} className="truncate font-medium hover:text-primary transition-colors">
                            {other.title}
                          </Link>
                          <span className="shrink-0 text-[10px] text-muted-foreground">{label}</span>
                        </div>
                        {canManageDependencies && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive shrink-0"
                            disabled={removingDepId === dep.id}
                            onClick={() => removeDependency(dep.id)}
                          >
                            {removingDepId === dep.id
                              ? <Loader2 className="h-3 w-3 animate-spin" />
                              : <Trash2 className="h-3 w-3" />
                            }
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {canManageDependencies && (
                <div className="pt-1 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">Add predecessor</p>
                  <div className="flex gap-2">
                    <Select value={newPredId} onValueChange={setNewPredId}>
                      <SelectTrigger className="h-8 text-xs flex-1 min-w-0">
                        <SelectValue placeholder="Select activity..." />
                      </SelectTrigger>
                      <SelectContent>
                        {allActivities.map((a) => (
                          <SelectItem key={a.id} value={a.id} className="text-xs">
                            {a.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={newDepType} onValueChange={setNewDepType}>
                      <SelectTrigger className="h-8 text-xs w-[130px] shrink-0">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(DEP_TYPE_LABELS).map(([k, v]) => (
                          <SelectItem key={k} value={k} className="text-xs">{v}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button size="sm" className="h-8 shrink-0" onClick={addDependency} disabled={addingDep || !newPredId}>
                      {addingDep ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Related Tickets */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Ticket className="h-4 w-4" />
                Related Tickets ({relatedTickets.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {relatedTickets.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No tickets linked to this activity.
                </p>
              ) : (
                <div className="space-y-2">
                  {relatedTickets.map((t) => (
                    <Link
                      key={t.id}
                      href={`/tickets/${t.id}`}
                      className="flex items-center justify-between p-2.5 rounded-lg border hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-xs text-muted-foreground shrink-0">
                          {formatTicketNumber(t.ticketNumber)}
                        </span>
                        <span className="text-sm font-medium truncate">{t.title}</span>
                      </div>
                      <span
                        className="text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ml-2"
                        style={{
                          backgroundColor: t.status.color + "22",
                          color: t.status.color,
                        }}
                      >
                        {t.status.name}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Full-width below the grid — see the comment above the grid for
          why these chronological/list sections aren't squeezed into
          either column. */}
      <div className="space-y-4">
        <EntityAttachments
          apiBasePath={`/api/activities/${id}`}
          initialAttachments={attachments}
          canManage={activity.canEditActivity ?? false}
        />

        <EntityNotes
          apiBasePath={`/api/activities/${id}`}
          initialNotes={notes}
          canAddNote={activity.canEditActivity ?? false}
          entityType="activity"
          entityId={id}
        />

        <EntityRelatedLinks entityType="activity" entityId={id} />
      </div>
    </div>
  );
}
