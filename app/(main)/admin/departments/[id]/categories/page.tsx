import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireDepartmentPermission } from "@/lib/permissions";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { DepartmentCategoriesManagement } from "@/components/admin/department-categories-management";

export default async function DepartmentCategoriesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  try {
    await requireDepartmentPermission(id, "department.manageSettings");
  } catch {
    redirect("/dashboard");
  }

  const department = await prisma.department.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!department) notFound();

  const categories = await prisma.ticketCategory.findMany({
    where: { OR: [{ departmentId: null }, { departmentId: id }] },
    orderBy: { name: "asc" },
    include: { _count: { select: { tickets: true } } },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/admin/departments" className="hover:text-foreground transition-colors">
          Departments
        </Link>
        <ChevronRight className="h-4 w-4" />
        <Link href={`/admin/departments/${department.id}`} className="hover:text-foreground transition-colors">
          {department.name}
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground font-medium">Categories</span>
      </div>

      <div>
        <h1 className="text-2xl font-bold">{department.name} — Categories</h1>
        <p className="text-muted-foreground mt-1">
          Ticket categories visible to this department: its own, plus any global ones.
        </p>
      </div>

      <DepartmentCategoriesManagement departmentId={department.id} categories={categories} />
    </div>
  );
}
