import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { hasPermission } from "@/lib/permissions";
import { TaskSubTypeManagement } from "@/components/admin/task-sub-type-management";

export default async function TaskSubTypesAdminPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // Its OWN dedicated permission (taskType.manage — the KEY itself is
  // deliberately UNCHANGED by the Activity Task Type -> Task Sub Type
  // rename, see TaskSubType in prisma/schema.prisma) — NOT bare
  // admin.access. Hiding this page is not authorization by itself; the API
  // routes independently re-check the same permission on every mutation.
  const allowed = await hasPermission(session.user.role, "taskType.manage", session.user.customRoleId);
  if (!allowed) redirect("/dashboard");

  const types = await prisma.taskSubType.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { activities: true } } },
  });
  // Prisma.Decimal is a class instance, not a plain serializable value — it
  // cannot cross the Server -> Client Component boundary as-is. Converted
  // to a plain number here, once, before handing off to the client
  // component below — `null` (no configured cost) is passed through
  // exactly as null, NEVER coerced to 0.
  const typesForClient = types.map((t) => ({ ...t, cost: t.cost === null ? null : Number(t.cost) }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Task Sub Types</h1>
        <p className="text-muted-foreground mt-1">
          Manage the Task Sub Type options offered when creating an Activity, and their optional configured cost.
        </p>
      </div>
      <TaskSubTypeManagement types={typesForClient} />
    </div>
  );
}
