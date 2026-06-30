import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { AdminConfigTable } from "@/components/admin/admin-config-table";

export default async function StatusesAdminPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/dashboard");

  const statuses = await prisma.ticketStatus.findMany({
    orderBy: { order: "asc" },
    include: { _count: { select: { tickets: true } } },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Ticket Statuses</h1>
        <p className="text-muted-foreground mt-1">Manage the ticket workflow statuses</p>
      </div>
      <AdminConfigTable
        title="Status"
        items={statuses as any}
        apiEndpoint="/api/admin/statuses"
        fields={[
          { key: "name", label: "Name", type: "text", required: true },
          { key: "color", label: "Color", type: "color", required: true },
          { key: "order", label: "Display Order", type: "number" },
        ]}
        extraColumns={[
          {
            type: "badges",
            header: "Type",
            badges: [
              { field: "isDefault", label: "Default", className: "bg-blue-100 text-blue-700" },
              { field: "isClosed", label: "Closed", className: "bg-gray-100 text-gray-700" },
            ],
          },
          { type: "field", header: "Tickets", field: "_count.tickets" },
        ]}
      />
    </div>
  );
}
