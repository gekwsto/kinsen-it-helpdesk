import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission, canManageProjects } from "@/lib/permissions";
import { buildActivityListWhere } from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { NoWorkspaceState, ChooseWorkspaceState } from "@/components/workspace/workspace-gate";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ActivityStatus } from "@prisma/client";
import { CheckSquare, Plus } from "lucide-react";
import { ActivityList, type SerializedActivity } from "@/components/activities/activity-list";

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

  if (!canManageProjects(session.user.role)) redirect("/dashboard");

  const canView = await hasPermission(session.user.role, "activity.view", session.user.customRoleId);
  if (!canView) redirect("/dashboard");

  const canCreate = await hasPermission(session.user.role, "activity.create", session.user.customRoleId);

  const params = await searchParams;

  const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
  if (!activeWorkspace.departmentId) {
    return activeWorkspace.departments.length === 0 ? (
      <NoWorkspaceState />
    ) : (
      <ChooseWorkspaceState departments={activeWorkspace.departments} />
    );
  }

  const scope = await buildActivityListWhere(session.user.id, session.user.role, activeWorkspace.departmentId);
  const andConditions: any[] = ["denied" in scope ? { id: { in: [] as string[] } } : scope];
  if (params.projectId) andConditions.push({ projectId: params.projectId });

  // Validate status against enum before passing to Prisma
  const validStatuses = Object.values(ActivityStatus) as string[];
  if (params.status && validStatuses.includes(params.status)) {
    andConditions.push({ status: params.status as ActivityStatus });
  }
  const where: any = { AND: andConditions };

  const activities = await prisma.projectActivity.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      project: { select: { id: true, title: true } },
      assignedUsers: { select: { id: true, name: true, email: true, image: true } },
    },
  });

  const serializedActivities: SerializedActivity[] = activities.map((a) => ({
    id: a.id,
    title: a.title,
    status: a.status,
    priority: a.priority,
    isCompleted: a.isCompleted,
    dueDate: a.dueDate?.toISOString() ?? null,
    project: a.project,
    assignedUsers: a.assignedUsers.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      image: u.image,
    })),
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Activities</h1>
          <p className="text-muted-foreground mt-1">All activities and tasks</p>
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

      {serializedActivities.length === 0 ? (
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
        <ActivityList activities={serializedActivities} />
      )}
    </div>
  );
}
