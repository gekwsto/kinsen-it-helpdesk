import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { hasPermission } from "@/lib/permissions";
import { TaskTypeManagement } from "@/components/admin/task-type-management";

export default async function TaskTypesAdminPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // Its OWN dedicated permission (projectRequestType.manage — the KEY
  // itself is deliberately UNCHANGED by the Project Request Type -> Task
  // Type rename, see TaskType in prisma/schema.prisma) — NOT bare
  // admin.access. Hiding this page is not authorization by itself; the API
  // routes independently re-check the same permission on every mutation.
  const allowed = await hasPermission(session.user.role, "projectRequestType.manage", session.user.customRoleId);
  if (!allowed) redirect("/dashboard");

  const types = await prisma.taskType.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { projectRequests: true, activities: true } } },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Task Types</h1>
        <p className="text-muted-foreground mt-1">
          Manage the Task Type options offered when creating an Activity.
        </p>
      </div>
      <TaskTypeManagement types={types} />
    </div>
  );
}
