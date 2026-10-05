import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { hasPermission } from "@/lib/permissions";
import { ProjectExpenseTypeManagement } from "@/components/admin/project-expense-type-management";

export default async function ProjectExpenseTypesAdminPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const allowed = await hasPermission(session.user.role, "admin.access", session.user.customRoleId);
  if (!allowed) redirect("/dashboard");

  const types = await prisma.projectExpenseType.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { projects: true } } },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Project Expense Types</h1>
        <p className="text-muted-foreground mt-1">
          Manage the Expense Type options offered when setting up a Project from an approved Project Request.
        </p>
      </div>
      <ProjectExpenseTypeManagement types={types} />
    </div>
  );
}
