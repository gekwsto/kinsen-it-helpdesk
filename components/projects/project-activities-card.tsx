"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials, formatDate } from "@/lib/utils";
import { ActivityCompleteCheckbox, type ActivityToggleResult } from "@/components/activities/activity-complete-checkbox";
import { StatusBadge } from "@/components/shared/activity-status-badge";
import { createTokenGuard } from "@/lib/navigation-loader";
import { LinkExistingActivityDialog } from "@/components/projects/link-existing-activity-dialog";
import { Link2 } from "lucide-react";

export interface ProjectActivityRow {
  id: string;
  title: string;
  /** ISO string — formatted client-side with the same formatDate() the previous server render used. */
  dueDate: string | null;
  /** ISO strings — same Expected Start/Finish fields ProjectActivity already carries (set only for a request-origin Project's Activities; null for a manual one). */
  expectedStartDate: string | null;
  expectedFinishDate: string | null;
  /** The legacy, editable "real" start date (ProjectActivity.startDate) — distinct from expectedStartDate above (the request-origin planning baseline). Set on any Activity, manual or request-origin. */
  startDate: string | null;
  /** Stamped server-side exactly at the authoritative COMPLETED transition (see app/api/activities/[id]/route.ts) — null until the Activity is actually completed, never a stand-in for expectedFinishDate. */
  completedAt: string | null;
  /** Whole calendar days, both already computed/stored server-side — never recalculated client-side. */
  expectedDays: number | null;
  actualDays: number | null;
  isCompleted: boolean;
  /** Pre-resolved server-side (see lib/services/activity-status-config.ts) — never re-derived client-side. */
  statusLabel: string;
  statusColor: string;
  assignedUsers: { id: string; name: string | null; image: string | null }[];
}

interface ProjectActivitiesCardProps {
  projectId: string;
  /** This Project's own title — passed through to LinkExistingActivityDialog as the reassignment destination's display name. */
  projectTitle: string;
  initialActivities: ProjectActivityRow[];
  initialProgress: number;
  progressIsCalculated: boolean;
  /** This Project's own departmentId — null hides the Link Activity button entirely (nothing to scope a candidate search to). */
  departmentId: string | null;
  /** activity.edit for this Project's own department — the SAME permission PATCH /api/activities/[id] itself requires to move an Activity's projectId; this only gates whether the button renders. */
  canLinkActivities: boolean;
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
export function ProjectActivitiesCard({ projectId, projectTitle, initialActivities, initialProgress, progressIsCalculated, departmentId, canLinkActivities }: ProjectActivitiesCardProps) {
  const router = useRouter();
  const [activities, setActivities] = useState(initialActivities);
  const [progress, setProgress] = useState(initialProgress);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);

  // initialActivities/initialProgress only change identity on a genuine
  // server re-render (router.refresh() or a navigation) — never as a side
  // effect of this component's OWN local state updates (the completion
  // toggle below never calls router.refresh(), it applies its PATCH
  // response directly to local state instead) — so re-syncing here can
  // never clobber an in-flight optimistic toggle. Needed because useState's
  // initial value is only consumed on first mount; without this, the newly
  // Linked Activity (see LinkExistingActivityDialog's onLinked ->
  // router.refresh()) would never actually appear until a hard reload.
  useEffect(() => {
    setActivities(initialActivities);
  }, [initialActivities]);
  useEffect(() => {
    setProgress(initialProgress);
  }, [initialProgress]);

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
    setActivities((prev) =>
      prev.map((a) =>
        a.id === activityId
          ? { ...a, isCompleted: result.isCompleted, statusLabel: result.statusLabel, statusColor: result.statusColor, completedAt: result.completedAt, actualDays: result.actualDays }
          : a
      )
    );

    const rollup = result.projectRollups.find((r) => r.id === projectId);
    if (rollup && tokenGuardRef.current.isCurrent(myToken)) {
      setProgress(rollup.progress);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base">Activities ({totalActivities})</CardTitle>
        <div className="flex items-center gap-3">
          {totalActivities > 0 && (
            <div className="text-right">
              <span className="text-sm text-muted-foreground">{progress}%</span>
              <p className="text-[10px] text-muted-foreground">
                {completedActivities} of {totalActivities} complete
                {progressIsCalculated ? " · Calculated from linked tickets" : " · Manual progress"}
              </p>
            </div>
          )}
          {canLinkActivities && departmentId && (
            <Button size="sm" className="gap-1.5" onClick={() => setLinkDialogOpen(true)}>
              <Link2 className="h-3.5 w-3.5" />
              Link Activity
            </Button>
          )}
        </div>
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
          // max-h + overflow-y-auto only on the row list itself — the header
          // (title/count/progress) above and the progress bar stay outside
          // this div, so they're never scrolled out of view.
          <div className="max-h-[520px] overflow-y-auto space-y-2 pr-1">
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
                    <div className="flex items-center gap-2 flex-wrap mt-0.5">
                      {activity.dueDate && (
                        <span className="text-xs text-muted-foreground whitespace-nowrap">Due: {formatDate(activity.dueDate)}</span>
                      )}
                      {activity.expectedStartDate && (
                        <span className="text-xs text-muted-foreground whitespace-nowrap">Expected Start: {formatDate(activity.expectedStartDate)}</span>
                      )}
                      {activity.expectedFinishDate && (
                        <span className="text-xs text-muted-foreground whitespace-nowrap">Expected Finish: {formatDate(activity.expectedFinishDate)}</span>
                      )}
                      {typeof activity.expectedDays === "number" && (
                        <span className="text-xs text-muted-foreground whitespace-nowrap">Expected Duration: {activity.expectedDays} day(s)</span>
                      )}
                      {activity.startDate && (
                        <span className="text-xs text-muted-foreground whitespace-nowrap">Actual Start: {formatDate(activity.startDate)}</span>
                      )}
                      {activity.completedAt && (
                        <span className="text-xs text-muted-foreground whitespace-nowrap">Actual Finish: {formatDate(activity.completedAt)}</span>
                      )}
                      {typeof activity.actualDays === "number" && (
                        <span className="text-xs text-muted-foreground whitespace-nowrap">Actual Duration: {activity.actualDays} day(s)</span>
                      )}
                    </div>
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
      {canLinkActivities && departmentId && (
        <LinkExistingActivityDialog
          open={linkDialogOpen}
          onOpenChange={setLinkDialogOpen}
          projectId={projectId}
          projectTitle={projectTitle}
          departmentId={departmentId}
          onLinked={() => router.refresh()}
        />
      )}
    </Card>
  );
}
