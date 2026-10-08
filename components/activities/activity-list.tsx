"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Eye, CheckSquare } from "lucide-react";
import { formatDate, getInitials } from "@/lib/utils";
import { ActivityStatus, ActivityPriority } from "@prisma/client";
import { toggleActivityComplete } from "@/components/activities/toggle-activity-complete";
import { resolveViewMode, type ViewMode } from "@/components/ui/view-toggle";
import { OverdueBadge } from "@/components/shared/overdue-badge";
import { ProgressConfigGapInline } from "@/components/shared/progress-display";
import { ActivityCard } from "@/components/activities/activity-card";
import { StatusBadge } from "@/components/shared/activity-status-badge";
import { MemberPreview } from "@/components/shared/member-preview";
import { PriorityBadge } from "@/components/shared/priority-badge";
import { PreviewField } from "@/components/shared/preview-field";

export interface SerializedActivity {
  id: string;
  title: string;
  status: ActivityStatus;
  /** This department's own configured display label for `status` — see lib/services/activity-status-config.ts. Never the raw enum key or a hardcoded map; a Finance-renamed TODO shows its own label here, independent of IT/Sales. */
  statusLabel: string;
  /** This department's own configured color for `status`, as a #RRGGBB hex value. */
  statusColor: string;
  priority: ActivityPriority;
  isCompleted: boolean;
  startDate: string | null;
  dueDate: string | null;
  /** null means no ActivityProgressConfig row is configured/enabled for this department+status — render "Configuration required", never "0%". See lib/activities/activity-progress.ts. */
  progress: number | null;
  /** Canonical creation timestamp — ProjectActivity.createdAt, never a derived/approximated date. */
  createdAt: string;
  /** Derived server-side via lib/overdue.ts — never a stored/stale flag. */
  overdue: boolean;
  project: { id: string; title: string } | null;
  department?: { id: string; name: string } | null;
  assignedUsers: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
  }[];
  /** Preview-only fields below — none change any existing column/sort/filter behavior. */
  description: string | null;
  owner: { id: string; name: string | null; email: string } | null;
  /** Request-origin-only planning dates — distinct from the legacy startDate/dueDate above. */
  expectedStartDate: string | null;
  expectedFinishDate: string | null;
  expectedDays: number | null;
  actualDays: number | null;
  taskType: { id: string; name: string } | null;
  taskSubType: { id: string; name: string } | null;
  /** The historical cost snapshot (see ProjectActivity.taskSubTypeCost's own schema doc comment) — null means no configured/manual cost, never 0. */
  taskSubTypeCost: number | null;
  /** Server-derived (computeActivityFinancials) — taskSubTypeCost × expectedDays/actualDays. Never stored, never editable. */
  estimatedCost: number | null;
  actualCost: number | null;
}

interface ActivityListProps {
  activities: SerializedActivity[];
  /** Matches the ViewToggle's own `defaultView` on the SAME page (see components/ui/view-toggle.tsx's resolveViewMode) — two independent Client Components reading the same `?view=` param, not prop-linked, so both must agree. Own default stays "grid" for any FUTURE caller that doesn't opt in — every current Activity-list page (/activities, /my-activities) explicitly passes "list" at its own call site. */
  defaultView?: ViewMode;
}

export function ActivityList({ activities: initialActivities, defaultView = "grid" }: ActivityListProps) {
  const searchParams = useSearchParams();
  const view = resolveViewMode(searchParams.get("view"), defaultView);
  const [activities, setActivities] = useState(initialActivities);
  // Tracks the last `initialActivities` reference `activities` was synced
  // from — NOT itself rendered, purely a comparison key.
  const [syncedFrom, setSyncedFrom] = useState(initialActivities);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  // Preview — mirrors the Project Requests list's own canonical pattern
  // (components/project-requests/project-request-table.tsx): a local-state
  // Dialog over a row already present in `activities` (no per-row fetch,
  // no N+1), opened via a dedicated Eye-icon trigger.
  const [previewTarget, setPreviewTarget] = useState<SerializedActivity | null>(null);

  // `activities` is intentionally local (not just the prop directly) so
  // handleToggle below can optimistically flip completion state without
  // waiting on a round-trip — but `useState(initialActivities)` only seeds
  // that state on the component's FIRST render. Without this, changing an
  // Activities filter (app/(main)/activities/page.tsx re-runs its query and
  // passes a genuinely new `activities` array down) updated the URL and the
  // page's own server data correctly, but this already-mounted client
  // component kept showing its stale local copy — exactly the "filters
  // change, results don't update until refresh" bug (a full reload remounts
  // this component, re-seeding useState from the now-correct prop, which is
  // why refreshing "fixed" it). Comparing reference identity DURING render
  // (not in a useEffect) re-syncs immediately, before paint, so there's no
  // stale-frame flash — see React's documented "adjusting state when a prop
  // changes" pattern. Never fires for an unrelated re-render (e.g. the
  // optimistic toggle below), since `initialActivities` only changes when
  // the Server Component actually re-ran with new searchParams.
  if (initialActivities !== syncedFrom) {
    setSyncedFrom(initialActivities);
    setActivities(initialActivities);
  }

  const handleToggle = async (activity: SerializedActivity) => {
    const previous = activity.isCompleted;
    setTogglingId(activity.id);
    // Optimistic flip, rolled back on failure below.
    setActivities((prev) =>
      prev.map((a) => (a.id === activity.id ? { ...a, isCompleted: !previous, status: !previous ? ActivityStatus.COMPLETED : ActivityStatus.IN_PROGRESS } : a))
    );
    try {
      const { isCompleted, status, progress, statusLabel, statusColor } = await toggleActivityComplete(activity.id, previous);
      setActivities((prev) => prev.map((a) => (a.id === activity.id ? { ...a, isCompleted, status: status as ActivityStatus, progress, statusLabel, statusColor } : a)));
    } catch (error: any) {
      setActivities((prev) => prev.map((a) => (a.id === activity.id ? { ...a, isCompleted: previous, status: activity.status } : a)));
      toast.error(error.message ?? "Failed to update activity");
    } finally {
      setTogglingId(null);
    }
  };

  const content = view === "list" ? (
      <div className="rounded-lg border overflow-hidden">
        <TooltipProvider delayDuration={200}>
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <SortableTableHead sortKey="title">Title</SortableTableHead>
              <SortableTableHead sortKey="project">Project</SortableTableHead>
              <SortableTableHead sortKey="department">Department</SortableTableHead>
              <SortableTableHead sortKey="status">Status</SortableTableHead>
              <SortableTableHead sortKey="priority">Priority</SortableTableHead>
              <TableHead>Assigned</TableHead>
              <SortableTableHead sortKey="startDate">Start</SortableTableHead>
              <SortableTableHead sortKey="dueDate">Due</SortableTableHead>
              <SortableTableHead sortKey="progress">Progress</SortableTableHead>
              <SortableTableHead sortKey="createdAt">Created</SortableTableHead>
              <TableHead className="w-24"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {activities.map((activity) => (
              <TableRow key={activity.id} className={activity.isCompleted ? "opacity-60" : undefined}>
                <TableCell>
                  <Link href={`/activities/${activity.id}`} className={`font-medium hover:text-primary line-clamp-1 ${activity.isCompleted ? "line-through" : ""}`}>
                    {activity.title}
                  </Link>
                </TableCell>
                <TableCell>
                  {activity.project ? (
                    <Link href={`/projects/${activity.project.id}`} className="text-sm text-primary hover:underline">
                      {activity.project.title}
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground italic">Standalone</span>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {activity.department?.name ?? "—"}
                </TableCell>
                <TableCell>
                  <StatusBadge label={activity.statusLabel} color={activity.statusColor} />
                </TableCell>
                <TableCell>
                  <PriorityBadge priority={activity.priority} />
                </TableCell>
                <TableCell>
                  {activity.assignedUsers.length > 0 ? (
                    <MemberPreview members={activity.assignedUsers} label="Assigned">
                      <div className="flex items-center gap-1">
                        {activity.assignedUsers.slice(0, 3).map((u) => (
                          <Avatar key={u.id} className="h-6 w-6 ring-2 ring-background -ml-1 first:ml-0">
                            <AvatarImage src={u.image ?? undefined} />
                            <AvatarFallback className="text-[9px]">{getInitials(u.name)}</AvatarFallback>
                          </Avatar>
                        ))}
                        {activity.assignedUsers.length > 3 && (
                          <span className="text-xs text-muted-foreground ml-1">+{activity.assignedUsers.length - 3}</span>
                        )}
                      </div>
                    </MemberPreview>
                  ) : (
                    <span className="text-xs text-muted-foreground">Unassigned</span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  {activity.startDate ? formatDate(activity.startDate) : "—"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  <div className="flex items-center gap-1.5">
                    {activity.dueDate ? formatDate(activity.dueDate) : "—"}
                    {activity.overdue && <OverdueBadge />}
                  </div>
                </TableCell>
                <TableCell>
                  {activity.progress === null ? (
                    <ProgressConfigGapInline />
                  ) : (
                    <div className="flex items-center gap-2 w-24">
                      <div className="h-1.5 flex-1 bg-muted rounded-full">
                        <div className="h-1.5 bg-primary rounded-full" style={{ width: `${activity.progress}%` }} />
                      </div>
                      <span className="text-xs text-muted-foreground w-8 text-right">{activity.progress}%</span>
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{formatDate(activity.createdAt)}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setPreviewTarget(activity)} title="Preview this activity">
                      <Eye className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" asChild>
                      <Link href={`/activities/${activity.id}`}>View</Link>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </TooltipProvider>
      </div>
    ) : (
      // Grid view — real Activity cards, same visual system as Project cards
      // (components/projects/project-list.tsx's own grid: same breakpoints,
      // same Card structure/spacing) rather than the old stacked-row layout.
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {activities.map((activity) => (
          <ActivityCard
            key={activity.id}
            activity={activity}
            toggling={togglingId === activity.id}
            onToggleComplete={handleToggle}
            onPreview={setPreviewTarget}
          />
        ))}
      </div>
    );

  const estimatedCostLine =
    previewTarget?.taskSubTypeCost !== null && previewTarget?.taskSubTypeCost !== undefined
      ? `€${previewTarget.taskSubTypeCost.toFixed(2)} / day${previewTarget.estimatedCost !== null ? ` · Estimated: €${previewTarget.estimatedCost.toFixed(2)}` : ""}${previewTarget.actualCost !== null ? ` · Actual: €${previewTarget.actualCost.toFixed(2)}` : ""}`
      : null;

  return (
    <>
      {content}

      {/* Preview dialog — read-only Activity detail, loaded from the SAME
          row data the list already fetched (no per-row/N+1 request) —
          mirrors components/project-requests/project-request-table.tsx's
          own Preview dialog exactly: same container size, same info-grid
          header, same scrollable PreviewField body, same Close + "Open"
          footer pattern. No edit controls anywhere. */}
      <Dialog open={!!previewTarget} onOpenChange={(o) => !o && setPreviewTarget(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="pr-6 break-words">{previewTarget?.title}</DialogTitle>
          </DialogHeader>
          {previewTarget && (
            <div className="flex-1 min-h-0 flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm border rounded-md p-3 bg-muted/30 flex-shrink-0">
                <div>
                  <span className="text-muted-foreground">Status: </span>
                  <StatusBadge label={previewTarget.statusLabel} color={previewTarget.statusColor} />
                </div>
                <div>
                  <span className="text-muted-foreground">Project: </span>
                  <span className="font-medium">{previewTarget.project?.title ?? "Standalone"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Owner: </span>
                  <span className="font-medium">{previewTarget.owner?.name ?? previewTarget.owner?.email ?? "—"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Priority: </span>
                  <PriorityBadge priority={previewTarget.priority} />
                </div>
                <div>
                  <span className="text-muted-foreground">Task Type: </span>
                  <span className="font-medium">{previewTarget.taskType?.name ?? "—"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Task Sub Type: </span>
                  <span className="font-medium">{previewTarget.taskSubType?.name ?? "—"}</span>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto rounded-md border divide-y">
                {(previewTarget.expectedStartDate || previewTarget.expectedFinishDate) && (
                  <PreviewField
                    label="Expected Timeline"
                    value={[
                      previewTarget.expectedStartDate ? `Start: ${formatDate(previewTarget.expectedStartDate)}` : null,
                      previewTarget.expectedFinishDate ? `Finish: ${formatDate(previewTarget.expectedFinishDate)}` : null,
                      previewTarget.expectedDays !== null ? `${previewTarget.expectedDays} day(s) expected` : null,
                    ]
                      .filter(Boolean)
                      .join("  ·  ")}
                  />
                )}
                {!(previewTarget.expectedStartDate || previewTarget.expectedFinishDate) && (previewTarget.startDate || previewTarget.dueDate) && (
                  <PreviewField
                    label="Start / Due"
                    value={[
                      previewTarget.startDate ? `Start: ${formatDate(previewTarget.startDate)}` : null,
                      previewTarget.dueDate ? `Due: ${formatDate(previewTarget.dueDate)}` : null,
                    ]
                      .filter(Boolean)
                      .join("  ·  ")}
                  />
                )}
                {previewTarget.actualDays !== null && <PreviewField label="Actual Days" value={`${previewTarget.actualDays} day(s)`} />}
                {estimatedCostLine && <PreviewField label="Cost" value={estimatedCostLine} />}
                <PreviewField
                  label="Related Users"
                  value={previewTarget.assignedUsers.length > 0 ? previewTarget.assignedUsers.map((u) => u.name ?? u.email).join(", ") : "Unassigned"}
                />
                {previewTarget.description && <PreviewField label="Description" value={previewTarget.description} multiline />}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewTarget(null)}>
              Close
            </Button>
            {previewTarget && (
              <Button asChild>
                <Link href={`/activities/${previewTarget.id}`}>
                  <CheckSquare className="h-3.5 w-3.5 mr-1.5" />
                  Open Activity
                </Link>
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
