import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { GoalStatus } from "@prisma/client";
import { Target, Plus, TrendingUp } from "lucide-react";

const STATUS_COLORS: Record<GoalStatus, string> = {
  NOT_STARTED: "bg-gray-100 text-gray-700",
  IN_PROGRESS: "bg-blue-100 text-blue-700",
  ON_TRACK: "bg-green-100 text-green-700",
  AT_RISK: "bg-orange-100 text-orange-700",
  COMPLETED: "bg-emerald-100 text-emerald-700",
  CANCELLED: "bg-gray-100 text-gray-500",
};

interface SearchParams { year?: string; status?: string }

export default async function GoalsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const canView = await hasPermission(session.user.role, "goal.view", session.user.customRoleId);
  if (!canView) redirect("/dashboard");

  const canCreate = await hasPermission(session.user.role, "goal.create", session.user.customRoleId);

  const params = await searchParams;
  const where: any = { ownerUserId: session.user.id };
  if (params.year) where.year = parseInt(params.year);
  if (params.status) where.status = params.status;

  const goals = await prisma.yearlyGoal.findMany({
    where,
    orderBy: [{ year: "desc" }, { createdAt: "desc" }],
    include: {
      projects: { select: { id: true, title: true } },
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">My Goals</h1>
          <p className="text-muted-foreground mt-1">
            Your personal yearly goals and objectives
          </p>
        </div>
        {canCreate && (
          <Button asChild>
            <Link href="/goals/new">
              <Plus className="h-4 w-4 mr-2" />
              New Goal
            </Link>
          </Button>
        )}
      </div>

      {goals.length === 0 ? (
        <div className="text-center py-20">
          <Target className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">No goals found.</p>
          {canCreate && (
            <Button asChild className="mt-4" variant="outline">
              <Link href="/goals/new">Create your first goal</Link>
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {goals.map((goal) => {
            const progress =
              goal.targetValue && goal.currentValue !== null && goal.currentValue !== undefined
                ? Math.min(100, Math.round((goal.currentValue / goal.targetValue) * 100))
                : null;

            return (
              <Link key={goal.id} href={`/goals/${goal.id}`}>
                <Card className="hover:shadow-sm transition-shadow cursor-pointer">
                  <CardContent className="py-4 px-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-semibold text-muted-foreground">
                            {goal.year}
                          </span>
                          <span
                            className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[goal.status]}`}
                          >
                            {goal.status.replace(/_/g, " ")}
                          </span>
                        </div>
                        {goal.unit && goal.targetValue && (
                          <p className="text-sm text-muted-foreground">
                            Target: {goal.targetValue} {goal.unit}
                          </p>
                        )}
                        {progress !== null && (
                          <div className="mt-2 flex items-center gap-2">
                            <div className="flex-1 h-1.5 bg-muted rounded-full">
                              <div
                                className="h-1.5 bg-primary rounded-full"
                                style={{ width: `${progress}%` }}
                              />
                            </div>
                            <span className="text-xs text-muted-foreground whitespace-nowrap">
                              {goal.currentValue}{goal.unit ? ` ${goal.unit}` : ""} / {goal.targetValue}{goal.unit ? ` ${goal.unit}` : ""}
                            </span>
                          </div>
                        )}
                        {goal.projects.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {goal.projects.map((p) => (
                              <span
                                key={p.id}
                                className="text-xs bg-muted px-2 py-0.5 rounded-full text-muted-foreground"
                              >
                                {p.title}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {progress !== null && (
                          <TrendingUp className="h-4 w-4 text-primary" />
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
