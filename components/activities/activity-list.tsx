"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
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
import { Calendar, Loader2 } from "lucide-react";
import { toggleActivityComplete } from "@/components/activities/toggle-activity-complete";
import type { ViewMode } from "@/components/ui/view-toggle";

const STATUS_COLORS: Record<ActivityStatus, string> = {
  TODO: "bg-gray-100 text-gray-700",
  IN_PROGRESS: "bg-blue-100 text-blue-700",
  ON_HOLD: "bg-orange-100 text-orange-700",
  BLOCKED: "bg-red-100 text-red-700",
  COMPLETED: "bg-green-100 text-green-700",
  CANCELLED: "bg-gray-100 text-gray-500",
};

const PRIORITY_COLORS: Record<ActivityPriority, string> = {
  LOW: "bg-green-50 text-green-700",
  MEDIUM: "bg-yellow-50 text-yellow-700",
  HIGH: "bg-orange-50 text-orange-700",
  URGENT: "bg-red-50 text-red-700",
};

export interface SerializedActivity {
  id: string;
  title: string;
  status: ActivityStatus;
  priority: ActivityPriority;
  isCompleted: boolean;
  startDate: string | null;
  dueDate: string | null;
  progress: number;
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
  const router = useRouter();
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
      const { isCompleted, status, progress } = await toggleActivityComplete(activity.id, previous);
      setActivities((prev) => prev.map((a) => (a.id === activity.id ? { ...a, isCompleted, status: status as ActivityStatus, progress } : a)));
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
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS_COLORS[activity.status]}`}>
                    {activity.status.replace(/_/g, " ")}
                  </span>
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
                  {activity.dueDate ? formatDate(activity.dueDate) : "—"}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2 w-24">
                    <div className="h-1.5 flex-1 bg-muted rounded-full">
                      <div className="h-1.5 bg-primary rounded-full" style={{ width: `${activity.progress}%` }} />
                    </div>
                    <span className="text-xs text-muted-foreground w-8 text-right">{activity.progress}%</span>
                  </div>
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

  return (
    <div className="space-y-2">
      {activities.map((activity) => (
        <div
          key={activity.id}
          className="cursor-pointer"
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
          <Card className="hover:shadow-sm transition-shadow">
            <CardContent className="py-3 px-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  {togglingId === activity.id ? (
                    <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-muted-foreground" />
                  ) : (
                    <input
                      type="checkbox"
                      checked={activity.isCompleted}
                      onChange={() => {}}
                      className="h-4 w-4 rounded flex-shrink-0 cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleToggle(activity);
                      }}
                    />
                  )}
                  <div className="min-w-0">
                    <p
                      className={`text-sm font-medium truncate ${
                        activity.isCompleted
                          ? "line-through text-muted-foreground"
                          : ""
                      }`}
                    >
                      {activity.title}
                    </p>
                    <div className="flex items-center gap-3 mt-0.5">
                      {activity.project ? (
                        <Link
                          href={`/projects/${activity.project.id}`}
                          className="text-xs text-primary hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {activity.project.title}
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground italic">
                          Standalone
                        </span>
                      )}
                      {activity.dueDate && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {formatDate(activity.dueDate)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full hidden sm:inline-flex ${PRIORITY_COLORS[activity.priority]}`}
                  >
                    {activity.priority}
                  </span>
                  {activity.assignedUsers.length > 0 && (
                    <div className="flex items-center gap-1">
                      {activity.assignedUsers.slice(0, 3).map((u) => (
                        <Avatar key={u.id} className="h-6 w-6 ring-2 ring-background -ml-1 first:ml-0">
                          <AvatarImage src={u.image ?? undefined} />
                          <AvatarFallback className="text-[9px]">
                            {getInitials(u.name)}
                          </AvatarFallback>
                        </Avatar>
                      ))}
                      {activity.assignedUsers.length > 3 && (
                        <span className="text-xs text-muted-foreground ml-1">
                          +{activity.assignedUsers.length - 3}
                        </span>
                      )}
                    </div>
                  )}
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[activity.status]}`}
                  >
                    {activity.status.replace(/_/g, " ")}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      ))}
    </div>
  );
}
