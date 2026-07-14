import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { DepartmentManagement } from "@/components/admin/department-management";

export default async function DepartmentsAdminPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/dashboard");

  const departments = await prisma.department.findMany({
    orderBy: { name: "asc" },
    include: {
      businessUnit: { select: { id: true, name: true } },
      _count: { select: { users: true, tickets: true } },
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Departments</h1>
        <p className="text-muted-foreground mt-1">
          Manage company departments/workspaces — activate, deactivate, and drill into members and categories.
        </p>
      </div>
      <DepartmentManagement departments={departments} />
    </div>
  );
}
