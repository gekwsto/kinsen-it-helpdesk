"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials, formatDate } from "@/lib/utils";
import { ActivityCompleteCheckbox, type ActivityToggleResult } from "@/components/activities/activity-complete-checkbox";
import { StatusBadge } from "@/components/shared/activity-status-badge";
import { createTokenGuard } from "@/lib/navigation-loader";

export interface ProjectActivityRow {
  id: string;
  title: string;
  /** ISO string — formatted client-side with the same formatDate() the previous server render used. */
  dueDate: string | null;
  isCompleted: boolean;
  /** Pre-resolved server-side (see lib/services/activity-status-config.ts) — never re-derived client-side. */
  statusLabel: string;
  statusColor: string;
  assignedUsers: { id: string; name: string | null; image: string | null }[];
}

interface ProjectActivitiesCardProps {
  projectId: string;
  initialActivities: ProjectActivityRow[];
  initialProgress: number;
  progressIsCalculated: boolean;
}

/**
 * Client-managed version of the Project detail page's "Activities" card —
 * previously this whole section (progress bar, completed/total counters,
 * and each row's title/status/checkbox) was server-rendered directly in
 * app/(main)/projects/[id]/page.tsx, which is why a completion toggle
 * needed a full route refresh (a whole-page RSC re-render) just to show its
 * own effect. Now a toggle's own PATCH response (see
 * ActivityCompleteCheckbox's onToggled) is applied directly to this
 * component's local state — no refresh, no re-fetch, same markup/behavior
 * otherwise.
 */
export function ProjectActivitiesCard({ projectId, initialActivities, initialProgress, progressIsCalculated }: ProjectActivitiesCardProps) {
  const [activities, setActivities] = useState(initialActivities);
  const [progress, setProgress] = useState(initialProgress);

  // Guards the SHARED project-level aggregate (progress) against a stale
  // response clobbering a newer one: two different rows' toggles can
  // resolve out of order (the first click's request taking longer than a
  // second, later click's). A response is only applied to `progress` while
  // it's still the most recently ISSUED one — the same token-guard pattern
  // already used by the app's global nav loader (lib/navigation-loader.ts).
  const tokenGuardRef = useRef(createTokenGuard());

  const totalActivities = activities.length;
  const completedActivities = activities.filter((a) => a.isCompleted).length;

  const handleToggled = (activityId: string) => (result: ActivityToggleResult) => {
    const myToken = tokenGuardRef.current.bump();
    // This row's own state is independent of any other row's toggle, and
    // always applies — the checkbox itself structurally prevents a second
    // concurrent toggle of the SAME row (it unmounts into a spinner for the
    // duration of its own request), so there is no same-row race to guard.
    setActivities((prev) => prev.map((a) => (a.id === activityId ? { ...a, isCompleted: result.isCompleted, statusLabel: result.statusLabel, statusColor: result.statusColor } : a)));

    const rollup = result.projectRollups.find((r) => r.id === projectId);
    if (rollup && tokenGuardRef.current.isCurrent(myToken)) {
      setProgress(rollup.progress);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base">Activities ({totalActivities})</CardTitle>
        {totalActivities > 0 && (
          <div className="text-right">
            <span className="text-sm text-muted-foreground">{progress}%</span>
            <p className="text-[10px] text-muted-foreground">
              {completedActivities} of {totalActivities} complete
              {progressIsCalculated ? " · Calculated from linked tickets" : " · Manual progress"}
            </p>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {totalActivities > 0 && (
          <div className="h-2 bg-muted rounded-full mb-4">
            <div className="h-2 bg-primary rounded-full transition-all" style={{ width: `${progress}%` }} />
          </div>
        )}

        {activities.length === 0 ? (
          <p className="text-center text-muted-foreground py-8 text-sm">No activities yet.</p>
        ) : (
          <div className="space-y-2">
            {activities.map((activity) => (
              <Link
                key={activity.id}
                href={`/activities/${activity.id}`}
                className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <ActivityCompleteCheckbox
                    activityId={activity.id}
                    initialIsCompleted={activity.isCompleted}
                    onToggled={handleToggled(activity.id)}
                  />
                  <div className="min-w-0">
                    <p className={`text-sm font-medium ${activity.isCompleted ? "line-through text-muted-foreground" : ""}`}>
                      {activity.title}
                    </p>
                    {activity.dueDate && (
                      <p className="text-xs text-muted-foreground">Due: {formatDate(activity.dueDate)}</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {activity.assignedUsers.slice(0, 2).map((u) => (
                    <Avatar key={u.id} className="h-6 w-6 ring-2 ring-background -ml-1 first:ml-0">
                      <AvatarImage src={u.image ?? undefined} />
                      <AvatarFallback className="text-[9px]">{getInitials(u.name)}</AvatarFallback>
                    </Avatar>
                  ))}
                  <StatusBadge label={activity.statusLabel} color={activity.statusColor} />
                </div>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
