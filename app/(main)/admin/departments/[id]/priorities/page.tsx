import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireAnyDepartmentPermission, hasDepartmentPermission } from "@/lib/permissions";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { WorkspaceConfigManager } from "@/components/admin/workspace-config-manager";

const PRIORITY_PERMISSION_KEYS = ["priority.create", "priority.edit", "priority.delete"];

const PRIORITY_FIELDS = [
  { key: "name", label: "Name", type: "text" as const, required: true },
  { key: "level", label: "Level (1 = lowest)", type: "number" as const, required: true },
  { key: "color", label: "Color", type: "color" as const, required: true },
];
const PRIORITY_EXTRA_COLUMNS = [
  { type: "field" as const, header: "Level", field: "level" },
  { type: "field" as const, header: "Tickets", field: "_count.tickets" },
];

export default async function DepartmentPrioritiesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  let access;
  try {
    access = await requireAnyDepartmentPermission(id, PRIORITY_PERMISSION_KEYS);
  } catch {
    redirect("/dashboard");
  }

  const department = await prisma.department.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!department) notFound();

  const [canCreate, canEdit, canDelete] = await Promise.all([
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "priority.create", access.membership!.customRoleId),
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "priority.edit", access.membership!.customRoleId),
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "priority.delete", access.membership!.customRoleId),
  ]);

  const priorities = await prisma.ticketPriority.findMany({
    where: { departmentId: id },
    orderBy: { level: "desc" },
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
        <span className="text-foreground font-medium">Priorities</span>
      </div>

      <div>
        <h1 className="text-2xl font-bold">{department.name} — Priorities</h1>
        <p className="text-muted-foreground mt-1">
          Ticket priorities visible to this department: its own, plus any global ones.
        </p>
      </div>

      <WorkspaceConfigManager
        entityLabel="Priority"
        entityLabelPlural="Priorities"
        apiEndpoint="/api/admin/priorities"
        items={priorities as any}
        fields={PRIORITY_FIELDS}
        extraColumns={PRIORITY_EXTRA_COLUMNS}
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
