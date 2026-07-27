import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireAnyDepartmentPermission, hasDepartmentPermission } from "@/lib/permissions";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { WorkspaceSlaManager } from "@/components/admin/workspace-sla-manager";
import { resolveSlaHoursFromRelation } from "@/lib/services/sla-policy";

const SLA_PERMISSION_KEYS = ["sla.create", "sla.edit", "sla.delete"];

export default async function DepartmentSlaPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  let access;
  try {
    access = await requireAnyDepartmentPermission(id, SLA_PERMISSION_KEYS);
  } catch {
    redirect("/dashboard");
  }

  const department = await prisma.department.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!department) notFound();

  const [canCreate, canEdit, canDelete] = await Promise.all([
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "sla.create", access.membership!.customRoleId),
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "sla.edit", access.membership!.customRoleId),
    access.isSystemAdmin || hasDepartmentPermission(access.membership!.role, "sla.delete", access.membership!.customRoleId),
  ]);

  const [settings, priorities] = await Promise.all([
    prisma.slaSettings.findFirst(),
    // Admin management view intentionally includes disabled levels too —
    // an admin must be able to see, re-enable, or safely delete a disabled
    // level here. Ticket-creation dropdowns filter to isActive:true on
    // their own (see e.g. app/(main)/tickets/new).
    prisma.ticketPriority.findMany({
      where: { departmentId: id },
      orderBy: { level: "desc" },
      include: { slaPolicy: true, department: { select: { id: true, name: true } }, _count: { select: { tickets: true } } },
    }),
  ]);

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
        <span className="text-foreground font-medium">SLA</span>
      </div>

      <div>
        <h1 className="text-2xl font-bold">{department.name} — SLA</h1>
        <p className="text-muted-foreground mt-1">
          Response/resolution hours for this department&apos;s own priorities.
        </p>
      </div>

      <WorkspaceSlaManager
        isEnabled={settings?.isEnabled ?? false}
        priorities={priorities.map((p) => {
          const resolution = resolveSlaHoursFromRelation(p.slaPolicy, p.id);
          return {
            id: p.id,
            name: p.name,
            color: p.color,
            level: p.level,
            isActive: p.isActive,
            departmentId: p.departmentId,
            department: p.department ?? null,
            // null means no SlaPolicy row exists — render "SLA not configured", never fabricate 8h/48h.
            firstResponseHours: resolution.ok ? resolution.hours.firstResponseHours : null,
            resolutionHours: resolution.ok ? resolution.hours.resolutionHours : null,
            hasPolicy: resolution.ok,
            ticketCount: p._count.tickets,
          };
        })}
        departmentOptions={[]}
        fixedDepartmentId={department.id}
        mode="scoped"
        canCreate={canCreate}
        canEdit={canEdit}
        canDelete={canDelete}
      />
    </div>
  );
}
