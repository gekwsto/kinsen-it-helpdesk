import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireAnyDepartmentPermission, hasAnyDepartmentPermission } from "@/lib/permissions";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { WorkspaceConfigManager } from "@/components/admin/workspace-config-manager";

// Categories are gated by the same OR-of-keys the API routes use — see
// app/api/admin/categories/route.ts's CATEGORY_PERMISSION_KEYS/
// CATEGORY_DELETE_PERMISSION_KEYS comments (category.manage is additive over
// the pre-existing department.manageSettings; category.delete is additive
// again on top of both, for delete specifically).
const CATEGORY_MANAGE_KEYS = ["category.manage", "department.manageSettings"];
const CATEGORY_DELETE_KEYS = ["category.delete", ...CATEGORY_MANAGE_KEYS];

const CATEGORY_FIELDS = [
  { key: "name", label: "Name", type: "text" as const, required: true },
  { key: "description", label: "Description", type: "textarea" as const },
  { key: "color", label: "Color", type: "color" as const },
];
const CATEGORY_EXTRA_COLUMNS = [{ type: "field" as const, header: "Tickets", field: "_count.tickets" }];

export default async function DepartmentCategoriesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  let access;
  try {
    access = await requireAnyDepartmentPermission(id, CATEGORY_DELETE_KEYS);
  } catch {
    redirect("/dashboard");
  }

  const department = await prisma.department.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!department) notFound();

  const [canManage, canDelete] = await Promise.all([
    access.isSystemAdmin || hasAnyDepartmentPermission(access.membership!.role, CATEGORY_MANAGE_KEYS, access.membership!.customRoleId),
    access.isSystemAdmin || hasAnyDepartmentPermission(access.membership!.role, CATEGORY_DELETE_KEYS, access.membership!.customRoleId),
  ]);

  const categories = await prisma.ticketCategory.findMany({
    where: { departmentId: id },
    orderBy: { name: "asc" },
    include: { _count: { select: { tickets: true } }, department: { select: { id: true, name: true } } },
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

      <WorkspaceConfigManager
        entityLabel="Category"
        entityLabelPlural="Categories"
        apiEndpoint="/api/admin/categories"
        items={categories as any}
        fields={CATEGORY_FIELDS}
        extraColumns={CATEGORY_EXTRA_COLUMNS}
        departmentOptions={[]}
        fixedDepartmentId={department.id}
        mode="scoped"
        canCreateGlobal={false}
        deleteSemantics="hard-when-unused"
        canCreate={canManage}
        canEdit={canManage}
        canDelete={canDelete}
      />
    </div>
  );
}
