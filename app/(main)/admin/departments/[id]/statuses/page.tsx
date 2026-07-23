import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireAnyDepartmentPermission, hasDepartmentPermission } from "@/lib/permissions";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { WorkspaceConfigManager } from "@/components/admin/workspace-config-manager";

const STATUS_PERMISSION_KEYS = ["status.create", "status.edit", "status.delete"];

const STATUS_FIELDS = [
  { key: "name", label: "Name", type: "text" as const, required: true },
  { key: "color", label: "Color", type: "color" as const, required: true },
  { key: "order", label: "Display Order", type: "number" as const },
  { key: "isDefault", label: "Default status for new tickets", type: "checkbox" as const },
  { key: "isClosed", label: "Counts as a closed/resolved state", type: "checkbox" as const },
];
const STATUS_EXTRA_COLUMNS = [
  {
    type: "badges" as const,
    header: "Type",
    badges: [
      { field: "isDefault", label: "Default", className: "bg-blue-100 text-blue-700" },
      { field: "isClosed", label: "Closed", className: "bg-gray-100 text-gray-700" },
    ],
  },
  { type: "field" as const, header: "Tickets", field: "_count.tickets" },
];

export default async function DepartmentStatusesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  let access;
  try {
    access = await requireAnyDepartmentPermission(id, STATUS_PERMISSION_KEYS);
  } catch {
    redirect("/dashboard");
  }

  const department = await prisma.department.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!department) notFound();

  const [canCreate, canEdit, canDelete] = await Promise.all([
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "status.create", access.membership!.customRoleId),
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "status.edit", access.membership!.customRoleId),
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "status.delete", access.membership!.customRoleId),
  ]);

  const statuses = await prisma.ticketStatus.findMany({
    where: { departmentId: id },
    orderBy: { order: "asc" },
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
        <span className="text-foreground font-medium">Statuses</span>
      </div>

      <div>
        <h1 className="text-2xl font-bold">{department.name} — Statuses</h1>
        <p className="text-muted-foreground mt-1">
          Ticket statuses visible to this department: its own, plus any global ones. A department-specific default
          is used for new tickets when set; otherwise the global default applies.
        </p>
      </div>

      <WorkspaceConfigManager
        entityLabel="Status"
        entityLabelPlural="Statuses"
        apiEndpoint="/api/admin/statuses"
        items={statuses as any}
        fields={STATUS_FIELDS}
        extraColumns={STATUS_EXTRA_COLUMNS}
        departmentOptions={[]}
        fixedDepartmentId={department.id}
        mode="scoped"
        canCreateGlobal={false}
        deleteSemantics="hard-when-unused"
        canCreate={canCreate}
        canEdit={canEdit}
        canDelete={canDelete}
      />
    </div>
  );
}
