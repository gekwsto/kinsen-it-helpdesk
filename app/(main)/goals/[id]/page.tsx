import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials } from "@/lib/utils";
import { ChevronRight, Target, FolderKanban, Pencil } from "lucide-react";
import { GoalStatus, ProjectStatus } from "@prisma/client";

const GOAL_STATUS_COLORS: Record<GoalStatus, string> = {
  NOT_STARTED: "bg-gray-100 text-gray-700",
  IN_PROGRESS: "bg-blue-100 text-blue-700",
  ON_TRACK: "bg-green-100 text-green-700",
  AT_RISK: "bg-orange-100 text-orange-700",
  COMPLETED: "bg-emerald-100 text-emerald-700",
  CANCELLED: "bg-gray-100 text-gray-500",
};

const PROJECT_STATUS_COLORS: Record<ProjectStatus, string> = {
  PLANNING: "bg-blue-100 text-blue-700",
  IN_PROGRESS: "bg-amber-100 text-amber-700",
  ON_HOLD: "bg-orange-100 text-orange-700",
  COMPLETED: "bg-green-100 text-green-700",
  CANCELLED: "bg-gray-100 text-gray-700",
};

export default async function GoalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  const canView = await hasPermission(session.user.role, "goal.view", session.user.customRoleId);
  if (!canView) redirect("/dashboard");

  const canEdit = await hasPermission(session.user.role, "goal.edit", session.user.customRoleId);

  const goal = await prisma.yearlyGoal.findUnique({
    where: { id },
    include: {
      owner: { select: { id: true, name: true, email: true, image: true } },
      projects: {
        select: {
          id: true,
          title: true,
          status: true,
          _count: { select: { activities: true } },
        },
      },
    },
  });

  if (!goal) notFound();

  const progress =
    goal.targetValue && goal.currentValue !== null && goal.currentValue !== undefined
      ? Math.min(100, Math.round((goal.currentValue / goal.targetValue) * 100))
      : null;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/goals" className="hover:text-foreground">Goals</Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground font-medium">{goal.title}</span>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <span className="text-sm font-semibold text-muted-foreground">{goal.year}</span>
            <h1 className="text-2xl font-bold">{goal.title}</h1>
            <span
              className={`text-xs font-medium px-2.5 py-1 rounded-full ${GOAL_STATUS_COLORS[goal.status]}`}
            >
              {goal.status.replace(/_/g, " ")}
            </span>
          </div>
          {goal.description && (
            <p className="text-muted-foreground">{goal.description}</p>
          )}
        </div>
        {canEdit && (
          <Button asChild variant="outline" size="sm">
            <Link href={`/goals/${id}/edit`}>
              <Pencil className="h-3.5 w-3.5 mr-1.5" />
              Edit
            </Link>
          </Button>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          {/* Linked Projects */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <FolderKanban className="h-4 w-4" />
                Linked Projects ({goal.projects.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {goal.projects.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No projects linked to this goal.
                </p>
              ) : (
                <div className="space-y-2">
                  {goal.projects.map((project) => (
                    <Link
                      key={project.id}
                      href={`/projects/${project.id}`}
                      className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
                    >
                      <div>
                        <p className="text-sm font-medium">{project.title}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {project._count.activities} activities
                        </p>
                      </div>
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded-full ${PROJECT_STATUS_COLORS[project.status]}`}
                      >
                        {project.status.replace(/_/g, " ")}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          {/* Progress */}
          {progress !== null && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Target className="h-4 w-4" />
                  Progress
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="h-2 bg-muted rounded-full">
                  <div
                    className="h-2 bg-primary rounded-full transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {goal.currentValue}{goal.unit ? ` ${goal.unit}` : ""}
                  </span>
                  <span className="font-semibold">{progress}%</span>
                  <span className="text-muted-foreground">
                    {goal.targetValue}{goal.unit ? ` ${goal.unit}` : ""}
                  </span>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Details */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Owner</p>
                <div className="flex items-center gap-2">
                  <Avatar className="h-6 w-6">
                    <AvatarImage src={goal.owner.image ?? undefined} />
                    <AvatarFallback className="text-[9px]">
                      {getInitials(goal.owner.name)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="font-medium">{goal.owner.name ?? goal.owner.email}</span>
                </div>
              </div>
              <Separator />
              <div>
                <p className="text-xs text-muted-foreground mb-1">Year</p>
                <p className="font-medium">{goal.year}</p>
              </div>
              {goal.unit && (
                <>
                  <Separator />
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Unit</p>
                    <p className="font-medium">{goal.unit}</p>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
