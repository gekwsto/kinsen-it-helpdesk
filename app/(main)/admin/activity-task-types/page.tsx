import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { hasPermission } from "@/lib/permissions";
import { ActivityTaskTypeManagement } from "@/components/admin/activity-task-type-management";

export default async function ActivityTaskTypesAdminPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // Its OWN dedicated permission (taskType.manage) — NOT bare admin.access.
  // Hiding this page is not authorization by itself; the API routes
  // independently re-check the same permission on every mutation.
  const allowed = await hasPermission(session.user.role, "taskType.manage", session.user.customRoleId);
  if (!allowed) redirect("/dashboard");

  const types = await prisma.activityTaskType.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { activities: true } } },
  });
  // Prisma.Decimal is a class instance, not a plain serializable value — it
  // cannot cross the Server -> Client Component boundary as-is. Converted
  // to a plain number here, once, before handing off to the client
  // component below.
  const typesForClient = types.map((t) => ({ ...t, cost: Number(t.cost) }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Task Types</h1>
        <p className="text-muted-foreground mt-1">
          Manage the Task Type options offered when creating an Activity under a request-origin Project, and their configured cost.
        </p>
      </div>
      <ActivityTaskTypeManagement types={typesForClient} />
    </div>
  );
}
