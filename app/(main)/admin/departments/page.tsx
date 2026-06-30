import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { AdminConfigTable } from "@/components/admin/admin-config-table";

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
        <p className="text-muted-foreground mt-1">Manage company departments</p>
      </div>
      <AdminConfigTable
        title="Department"
        items={departments as any}
        apiEndpoint="/api/admin/departments"
        fields={[
          { key: "name", label: "Name", type: "text", required: true },
        ]}
        extraColumns={[
          { type: "field", header: "Business Unit", field: "businessUnit.name" },
          { type: "field", header: "Users", field: "_count.users" },
          { type: "field", header: "Tickets", field: "_count.tickets" },
        ]}
      />
    </div>
  );
}
