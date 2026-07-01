"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatDate, getInitials } from "@/lib/utils";
import { ActivityStatus, ActivityPriority } from "@prisma/client";
import { Calendar } from "lucide-react";

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
  dueDate: string | null;
  project: { id: string; title: string } | null;
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

export function ActivityList({ activities }: ActivityListProps) {
  const router = useRouter();

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
                  <input
                    type="checkbox"
                    checked={activity.isCompleted}
                    readOnly
                    className="h-4 w-4 rounded flex-shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  />
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
