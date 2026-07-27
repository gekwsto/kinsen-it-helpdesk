"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Calendar, Loader2 } from "lucide-react";
import { formatDate, getInitials } from "@/lib/utils";
import { ActivityPriority } from "@prisma/client";
import { OverdueBadge } from "@/components/shared/overdue-badge";
import { ProgressConfigGapInline } from "@/components/shared/progress-display";
import { StatusBadge } from "@/components/shared/activity-status-badge";
import type { SerializedActivity } from "@/components/activities/activity-list";

// Status label/color are no longer a static Record — every activity carries
// its OWN department-resolved statusLabel/statusColor (see
// lib/services/activity-status-config.ts), rendered via the shared
// <StatusBadge> component so List and Grid can never visually drift apart.

export const PRIORITY_COLORS: Record<ActivityPriority, string> = {
  LOW: "bg-green-50 text-green-700",
  MEDIUM: "bg-yellow-50 text-yellow-700",
  HIGH: "bg-orange-50 text-orange-700",
  URGENT: "bg-red-50 text-red-700",
};

interface ActivityCardProps {
  activity: SerializedActivity;
  toggling: boolean;
  onToggleComplete: (activity: SerializedActivity) => void;
}

/**
 * Grid-view card — deliberately mirrors components/projects/project-list.tsx's
 * own Grid card structure/typography/spacing exactly (same Card/CardHeader/
 * CardContent shape, same "title + status badge" header row, same muted
 * meta row, same Calendar-icon date line, same bottom avatars-left/count-
 * right row) rather than inventing a second design — the only real
 * differences are activity-specific fields (parent project instead of
 * department, priority + assignees instead of members, an overdue badge
 * placed the same way the Project card places its own, and the completion
 * checkbox the List view already offers as its one inline action).
 */
export function ActivityCard({ activity, toggling, onToggleComplete }: ActivityCardProps) {
  const router = useRouter();

  return (
    <div
      className="cursor-pointer h-full"
      role="button"
      tabIndex={0}
      onClick={() => router.push(`/activities/${activity.id}`)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          router.push(`/activities/${activity.id}`);
        }
      }}
    >
      <Card className="h-full hover:shadow-md transition-shadow cursor-pointer">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2 min-w-0">
              {toggling ? (
                <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-muted-foreground mt-0.5" />
              ) : (
                <input
                  type="checkbox"
                  checked={activity.isCompleted}
                  onChange={() => {}}
                  className="h-4 w-4 rounded flex-shrink-0 cursor-pointer mt-0.5"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleComplete(activity);
                  }}
                  aria-label={activity.isCompleted ? "Mark as not completed" : "Mark as completed"}
                />
              )}
              <CardTitle
                className={`text-base line-clamp-2 break-words ${activity.isCompleted ? "line-through text-muted-foreground" : ""}`}
              >
                {activity.title}
              </CardTitle>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {activity.overdue && <OverdueBadge />}
              <StatusBadge label={activity.statusLabel} color={activity.statusColor} />
            </div>
          </div>
          <CardDescription>
            {activity.project ? (
              <Link
                href={`/projects/${activity.project.id}`}
                className="text-primary hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {activity.project.title}
              </Link>
            ) : (
              <span className="italic">Standalone activity</span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
            {activity.department && <span>{activity.department.name}</span>}
            <Badge variant="outline" className={`text-xs border-0 ${PRIORITY_COLORS[activity.priority]}`}>
              {activity.priority}
            </Badge>
          </div>

          {(activity.startDate || activity.dueDate) && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Calendar className="h-3.5 w-3.5 flex-shrink-0" />
              {activity.startDate && formatDate(activity.startDate)}
              {activity.startDate && activity.dueDate && " → "}
              {activity.dueDate && formatDate(activity.dueDate)}
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
              {activity.assignedUsers.length > 0 ? (
                <div className="flex items-center -space-x-1">
                  {activity.assignedUsers.slice(0, 3).map((u) => (
                    <Avatar key={u.id} className="h-6 w-6 ring-2 ring-background">
                      <AvatarImage src={u.image ?? undefined} />
                      <AvatarFallback className="text-[9px]">{getInitials(u.name)}</AvatarFallback>
                    </Avatar>
                  ))}
                  {activity.assignedUsers.length > 3 && (
                    <span className="text-xs text-muted-foreground ml-2">+{activity.assignedUsers.length - 3}</span>
                  )}
                </div>
              ) : (
                <span>Unassigned</span>
              )}
            </div>
            {activity.progress === null ? (
              <ProgressConfigGapInline className="flex-shrink-0" />
            ) : (
              <span className="text-xs text-muted-foreground flex-shrink-0">{activity.progress}% done</span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
