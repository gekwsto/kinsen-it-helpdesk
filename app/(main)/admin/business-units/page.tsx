import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { BusinessUnitManagement } from "@/components/admin/business-unit-management";

export default async function BusinessUnitsAdminPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/dashboard");

  const [businessUnits, companies] = await Promise.all([
    prisma.businessUnit.findMany({
      orderBy: { name: "asc" },
      include: {
        company: { select: { id: true, name: true } },
        _count: { select: { departments: true, users: true, projects: true, activities: true } },
      },
    }),
    prisma.company.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Business Units</h1>
        <p className="text-muted-foreground mt-1">
          Manage business units within each company — the level directly above departments.
        </p>
      </div>
      <BusinessUnitManagement businessUnits={businessUnits} companies={companies} />
    </div>
  );
}
