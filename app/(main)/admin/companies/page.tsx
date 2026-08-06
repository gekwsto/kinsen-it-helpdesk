import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { CompanyManagement } from "@/components/admin/company-management";

export default async function CompaniesAdminPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/dashboard");

  const companies = await prisma.company.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { businessUnits: true, users: true } } },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Companies</h1>
        <p className="text-muted-foreground mt-1">
          Manage the companies at the root of your organization hierarchy — name, domain, and business units.
        </p>
      </div>
      <CompanyManagement companies={companies} />
    </div>
  );
}
