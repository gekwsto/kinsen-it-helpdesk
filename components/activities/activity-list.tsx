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
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatDate, getInitials } from "@/lib/utils";
import { ActivityStatus, ActivityPriority } from "@prisma/client";
import { toggleActivityComplete } from "@/components/activities/toggle-activity-complete";
import type { ViewMode } from "@/components/ui/view-toggle";
import { OverdueBadge } from "@/components/shared/overdue-badge";
import { ProgressConfigGapInline } from "@/components/shared/progress-display";
import { ActivityCard, PRIORITY_COLORS } from "@/components/activities/activity-card";
import { StatusBadge } from "@/components/shared/activity-status-badge";

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
}

interface ActivityListProps {
  activities: SerializedActivity[];
}

export function ActivityList({ activities: initialActivities }: ActivityListProps) {
  const searchParams = useSearchParams();
  const view = (searchParams.get("view") as ViewMode | null) ?? "grid";
  const [activities, setActivities] = useState(initialActivities);
  const [togglingId, setTogglingId] = useState<string | null>(null);

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

  if (view === "list") {
    return (
      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>Title</TableHead>
              <TableHead>Project</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Assigned</TableHead>
              <TableHead>Start</TableHead>
              <TableHead>Due</TableHead>
              <TableHead>Progress</TableHead>
              <TableHead className="w-16"></TableHead>
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
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${PRIORITY_COLORS[activity.priority]}`}>
                    {activity.priority}
                  </span>
                </TableCell>
                <TableCell>
                  {activity.assignedUsers.length > 0 ? (
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
                <TableCell>
                  <Button size="sm" variant="ghost" asChild>
                    <Link href={`/activities/${activity.id}`}>View</Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  // Grid view — real Activity cards, same visual system as Project cards
  // (components/projects/project-list.tsx's own grid: same breakpoints,
  // same Card structure/spacing) rather than the old stacked-row layout.
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {activities.map((activity) => (
        <ActivityCard
          key={activity.id}
          activity={activity}
          toggling={togglingId === activity.id}
          onToggleComplete={handleToggle}
        />
      ))}
    </div>
  );
}
