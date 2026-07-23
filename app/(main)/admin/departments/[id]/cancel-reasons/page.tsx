import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireAnyDepartmentPermission, hasDepartmentPermission } from "@/lib/permissions";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { WorkspaceConfigManager } from "@/components/admin/workspace-config-manager";

const CANCEL_REASON_PERMISSION_KEYS = ["cancelReason.create", "cancelReason.edit", "cancelReason.delete"];

const CANCEL_REASON_FIELDS = [
  { key: "name", label: "Name", type: "text" as const, required: true },
  { key: "description", label: "Description", type: "textarea" as const },
];

export default async function DepartmentCancelReasonsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  let access;
  try {
    access = await requireAnyDepartmentPermission(id, CANCEL_REASON_PERMISSION_KEYS);
  } catch {
    redirect("/dashboard");
  }

  const department = await prisma.department.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!department) notFound();

  const [canCreate, canEdit, canDelete] = await Promise.all([
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "cancelReason.create", access.membership!.customRoleId),
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "cancelReason.edit", access.membership!.customRoleId),
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "cancelReason.delete", access.membership!.customRoleId),
  ]);

  const reasons = await prisma.ticketCancelReason.findMany({
    where: { OR: [{ departmentId: null }, { departmentId: id }] },
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
        <span className="text-foreground font-medium">Cancel Reasons</span>
      </div>

      <div>
        <h1 className="text-2xl font-bold">{department.name} — Cancel Reasons</h1>
        <p className="text-muted-foreground mt-1">
          Cancellation reasons visible to this department: its own, plus any global ones.
        </p>
      </div>

      <WorkspaceConfigManager
        entityLabel="Cancel Reason"
        entityLabelPlural="Cancel Reasons"
        apiEndpoint="/api/admin/cancel-reasons"
        items={reasons as any}
        fields={CANCEL_REASON_FIELDS}
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
