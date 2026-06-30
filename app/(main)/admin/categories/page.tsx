import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { AdminConfigTable } from "@/components/admin/admin-config-table";

export default async function CategoriesAdminPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/dashboard");

  const categories = await prisma.ticketCategory.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { tickets: true } } },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Categories</h1>
        <p className="text-muted-foreground mt-1">Manage ticket categories</p>
      </div>
      <AdminConfigTable
        title="Category"
        items={categories as any}
        apiEndpoint="/api/admin/categories"
        fields={[
          { key: "name", label: "Name", type: "text", required: true },
          { key: "description", label: "Description", type: "textarea" },
          { key: "color", label: "Color", type: "color" },
        ]}
        extraColumns={[
          { type: "field", header: "Tickets", field: "_count.tickets" },
        ]}
      />
    </div>
  );
}
