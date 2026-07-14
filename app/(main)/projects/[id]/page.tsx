import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canActOnEntity } from "@/lib/services/department-scope-service";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatDate, getInitials } from "@/lib/utils";
import { ChevronRight, Calendar, Users, Target, Plus, Ticket, Pencil } from "lucide-react";
import { ProjectStatus, ActivityStatus, GoalStatus, Role } from "@prisma/client";
import { formatTicketNumber } from "@/lib/utils";
import { ProjectDeleteButton } from "@/components/projects/project-delete-button";

const STATUS_COLORS: Record<ProjectStatus, string> = {
  PLANNING: "bg-blue-100 text-blue-700",
  IN_PROGRESS: "bg-amber-100 text-amber-700",
  ON_HOLD: "bg-orange-100 text-orange-700",
  COMPLETED: "bg-green-100 text-green-700",
  CANCELLED: "bg-gray-100 text-gray-700",
};

const ACTIVITY_STATUS_COLORS: Record<ActivityStatus, string> = {
  TODO: "bg-gray-100 text-gray-700",
  IN_PROGRESS: "bg-blue-100 text-blue-700",
  ON_HOLD: "bg-orange-100 text-orange-700",
  BLOCKED: "bg-red-100 text-red-700",
  COMPLETED: "bg-green-100 text-green-700",
  CANCELLED: "bg-gray-100 text-gray-500",
};

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      owner: { select: { id: true, name: true, email: true, image: true } },
      department: { select: { id: true, name: true } },
      businessUnit: { select: { id: true, name: true } },
      members: { select: { id: true, name: true, email: true, image: true } },
      activities: {
        orderBy: { createdAt: "desc" },
        include: {
          assignedUsers: { select: { id: true, name: true, image: true } },
        },
      },
      yearlyGoals: { select: { id: true, year: true, status: true, targetValue: true, currentValue: true, unit: true } },
    },
  });

  if (!project) notFound();

  // Department-scoped, not just "can this role ever view projects" — this
  // page previously had no per-project check at all beyond that global gate.
  const canView = await canActOnEntity(session.user.id, session.user.role, project.departmentId, "project.view");
  if (!canView) redirect("/dashboard");

  const isAdmin = session.user.role === Role.ADMIN;
  const activityIds = project.activities.map((a) => a.id);

  const relatedTickets = await prisma.ticket.findMany({
    where: {
      OR: [
        { projectId: id },
        ...(activityIds.length > 0 ? [{ activityId: { in: activityIds } }] : []),
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    include: {
      status: { select: { id: true, name: true, color: true } },
      requester: { select: { id: true, name: true } },
    },
  });

  const completedActivities = project.activities.filter((a) => a.isCompleted).length;
  const totalActivities = project.activities.length;
  const progress = project.progress;
  const progressIsCalculated = relatedTickets.length > 0;

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">
          Projects
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground font-medium">{project.title}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-bold">{project.title}</h1>
            <span
              className={`text-xs font-medium px-2.5 py-1 rounded-full ${STATUS_COLORS[project.status]}`}
            >
              {project.status.replace("_", " ")}
            </span>
            {project.isGoal && (
              <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-purple-100 text-purple-700">
                Goal
              </span>
            )}
          </div>
          {project.description && (
            <p className="text-muted-foreground">{project.description}</p>
          )}
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href={`/projects/${project.id}/edit`}>
              <Pencil className="h-4 w-4 mr-2" />
              Edit
            </Link>
          </Button>
          <Button asChild>
            <Link href={`/activities?projectId=${project.id}`}>
              <Plus className="h-4 w-4 mr-2" />
              Add Activity
            </Link>
          </Button>
          {isAdmin && (
            <ProjectDeleteButton
              projectId={project.id}
              projectTitle={project.title}
            />
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Activities */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-base">
                Activities ({totalActivities})
              </CardTitle>
              {totalActivities > 0 && (
                <div className="text-right">
                  <span className="text-sm text-muted-foreground">{progress}%</span>
                  <p className="text-[10px] text-muted-foreground">
                    {progressIsCalculated ? "Calculated from linked tickets" : "Manual progress"}
                  </p>
                </div>
              )}
            </CardHeader>
            <CardContent>
              {totalActivities > 0 && (
                <div className="h-2 bg-muted rounded-full mb-4">
                  <div
                    className="h-2 bg-primary rounded-full transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              )}

              {project.activities.length === 0 ? (
                <p className="text-center text-muted-foreground py-8 text-sm">
                  No activities yet.
                </p>
              ) : (
                <div className="space-y-2">
                  {project.activities.map((activity) => (
                    <Link
                      key={activity.id}
                      href={`/activities/${activity.id}`}
                      className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <input
                          type="checkbox"
                          checked={activity.isCompleted}
                          readOnly
                          className="h-4 w-4 rounded"
                        />
                        <div className="min-w-0">
                          <p
                            className={`text-sm font-medium ${
                              activity.isCompleted
                                ? "line-through text-muted-foreground"
                                : ""
                            }`}
                          >
                            {activity.title}
                          </p>
                          {activity.dueDate && (
                            <p className="text-xs text-muted-foreground">
                              Due: {formatDate(activity.dueDate)}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {activity.assignedUsers.slice(0, 2).map((u) => (
                          <Avatar key={u.id} className="h-6 w-6 ring-2 ring-background -ml-1 first:ml-0">
                            <AvatarImage src={u.image ?? undefined} />
                            <AvatarFallback className="text-[9px]">
                              {getInitials(u.name)}
                            </AvatarFallback>
                          </Avatar>
                        ))}
                        <span
                          className={`text-xs font-medium px-2 py-0.5 rounded-full ${ACTIVITY_STATUS_COLORS[activity.status]}`}
                        >
                          {activity.status.replace("_", " ")}
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

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
              <p className="text-center text-muted-foreground py-4 text-sm">
                No tickets linked to this project.
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

        {/* Sidebar */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Project Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Owner</p>
                <div className="flex items-center gap-2">
                  <Avatar className="h-6 w-6">
                    <AvatarImage src={project.owner.image ?? undefined} />
                    <AvatarFallback className="text-[9px]">
                      {getInitials(project.owner.name)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="font-medium">{project.owner.name}</span>
                </div>
              </div>

              {(project.startDate || project.endDate) && (
                <>
                  <Separator />
                  <div>
                    <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                      <Calendar className="h-3 w-3" /> Timeline
                    </p>
                    <div className="text-sm">
                      {project.startDate && (
                        <p>Start: {formatDate(project.startDate)}</p>
                      )}
                      {project.endDate && (
                        <p>End: {formatDate(project.endDate)}</p>
                      )}
                    </div>
                  </div>
                </>
              )}

              {project.department && (
                <>
                  <Separator />
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Department</p>
                    <p className="font-medium">{project.department.name}</p>
                  </div>
                </>
              )}

              {project.members.length > 0 && (
                <>
                  <Separator />
                  <div>
                    <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                      <Users className="h-3 w-3" /> Members
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {project.members.map((m) => (
                        <div key={m.id} className="flex items-center gap-1.5 text-xs">
                          <Avatar className="h-5 w-5">
                            <AvatarImage src={m.image ?? undefined} />
                            <AvatarFallback className="text-[9px]">
                              {getInitials(m.name)}
                            </AvatarFallback>
                          </Avatar>
                          {m.name}
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {project.successTarget && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Target className="h-4 w-4" />
                  Success Target
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-muted-foreground">{project.successTarget}</p>
              </CardContent>
            </Card>
          )}

          {project.yearlyGoals.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Target className="h-4 w-4" />
                  Linked Goals ({project.yearlyGoals.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {project.yearlyGoals.map((goal) => {
                  const GOAL_STATUS_COLORS: Record<GoalStatus, string> = {
                    NOT_STARTED: "bg-gray-100 text-gray-700",
                    IN_PROGRESS: "bg-blue-100 text-blue-700",
                    ON_TRACK: "bg-green-100 text-green-700",
                    AT_RISK: "bg-orange-100 text-orange-700",
                    COMPLETED: "bg-emerald-100 text-emerald-700",
                    CANCELLED: "bg-gray-100 text-gray-500",
                  };
                  return (
                    <Link
                      key={goal.id}
                      href={`/goals/${goal.id}`}
                      className="flex items-center justify-between p-2 rounded-lg border hover:bg-muted/50 transition-colors"
                    >
                      <span className="text-sm font-medium">{goal.year}</span>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${GOAL_STATUS_COLORS[goal.status]}`}>
                        {goal.status.replace(/_/g, " ")}
                      </span>
                    </Link>
                  );
                })}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
