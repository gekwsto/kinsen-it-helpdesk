import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { AdminConfigTable } from "@/components/admin/admin-config-table";

export default async function PrioritiesAdminPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/dashboard");

  const priorities = await prisma.ticketPriority.findMany({
    orderBy: { level: "desc" },
    include: { _count: { select: { tickets: true } } },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Priorities</h1>
        <p className="text-muted-foreground mt-1">Manage ticket priority levels</p>
      </div>
      <AdminConfigTable
        title="Priority"
        items={priorities as any}
        apiEndpoint="/api/admin/priorities"
        fields={[
          { key: "name", label: "Name", type: "text", required: true },
          { key: "level", label: "Level (1=lowest)", type: "number", required: true },
          { key: "color", label: "Color", type: "color", required: true },
        ]}
        extraColumns={[
          { type: "field", header: "Level", field: "level" },
          { type: "field", header: "Tickets", field: "_count.tickets" },
        ]}
      />
    </div>
  );
}
