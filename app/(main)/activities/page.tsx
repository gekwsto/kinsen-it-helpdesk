import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatDate, getInitials } from "@/lib/utils";
import { ActivityStatus, ActivityPriority } from "@prisma/client";
import { CheckSquare, Calendar, Plus } from "lucide-react";

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

interface SearchParams {
  projectId?: string;
  status?: string;
}

export default async function ActivitiesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const canView = await hasPermission(session.user.role, "activity.view", session.user.customRoleId);
  if (!canView) redirect("/dashboard");

  const canCreate = await hasPermission(session.user.role, "activity.create", session.user.customRoleId);

  const params = await searchParams;
  const where: any = {};
  if (params.projectId) where.projectId = params.projectId;
  if (params.status) where.status = params.status;

  const activities = await prisma.projectActivity.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      project: { select: { id: true, title: true } },
      assignedUser: { select: { id: true, name: true, email: true, image: true } },
      department: { select: { id: true, name: true } },
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Activities</h1>
          <p className="text-muted-foreground mt-1">
            All activities and tasks
          </p>
        </div>
        {canCreate && (
          <Button asChild>
            <Link href="/activities/new">
              <Plus className="h-4 w-4 mr-2" />
              New Activity
            </Link>
          </Button>
        )}
      </div>

      {activities.length === 0 ? (
        <div className="text-center py-20">
          <CheckSquare className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">No activities found.</p>
          {canCreate && (
            <Button asChild className="mt-4" variant="outline">
              <Link href="/activities/new">Create your first activity</Link>
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {activities.map((activity) => (
            <Link key={activity.id} href={`/activities/${activity.id}`}>
              <Card className="hover:shadow-sm transition-shadow cursor-pointer">
                <CardContent className="py-3 px-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <input
                        type="checkbox"
                        checked={activity.isCompleted}
                        readOnly
                        className="h-4 w-4 rounded flex-shrink-0"
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
                      {activity.assignedUser && (
                        <div className="flex items-center gap-1.5">
                          <Avatar className="h-6 w-6">
                            <AvatarImage src={activity.assignedUser.image ?? undefined} />
                            <AvatarFallback className="text-[9px]">
                              {getInitials(activity.assignedUser.name)}
                            </AvatarFallback>
                          </Avatar>
                          <span className="text-xs text-muted-foreground hidden sm:block">
                            {activity.assignedUser.name}
                          </span>
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
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
