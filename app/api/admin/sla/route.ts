import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireAnyDepartmentPermission, requireDepartmentPermission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { buildPriorityWhere } from "@/lib/services/department-scope-service";

const SLA_PERMISSION_KEYS = ["sla.create", "sla.edit", "sla.delete"];

// GET /api/admin/sla               -> every priority + policy (System Admin only, unchanged global view)
// GET /api/admin/sla?departmentId=X -> strictly that department's own priorities —
//   System Admin or anyone holding an sla.* permission in X.
// SLA has no independent record of its own: SlaPolicy is 1:1 with
// TicketPriority, so department scoping here is entirely inherited from
// which priorities the caller can see/edit (see buildPriorityWhere).
export async function GET(req: NextRequest) {
  try {
    const departmentId = req.nextUrl.searchParams.get("departmentId");

    if (departmentId) {
      await requireAnyDepartmentPermission(departmentId, SLA_PERMISSION_KEYS);
    } else {
      await requireAdmin();
    }

    const [settings, priorities] = await Promise.all([
      prisma.slaSettings.findFirst(),
      prisma.ticketPriority.findMany({
        where: departmentId ? { AND: [{ isActive: true }, buildPriorityWhere(departmentId)] } : { isActive: true },
        orderBy: { level: "desc" },
        include: { slaPolicy: true, department: { select: { id: true, name: true } } },
      }),
    ]);

    return NextResponse.json({
      isEnabled: settings?.isEnabled ?? false,
      priorities: priorities.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        level: p.level,
        departmentId: p.departmentId,
        department: p.department,
        firstResponseHours: p.slaPolicy?.firstResponseHours ?? 8,
        resolutionHours: p.slaPolicy?.resolutionHours ?? 48,
      })),
    });
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { departmentId, isEnabled, policies } = await req.json();

    if (departmentId) {
      await requireDepartmentPermission(departmentId, "sla.edit");
      // The global enable/disable switch is a system-wide feature flag
      // (SlaSettings is a singleton, not department-scoped) — only a System
      // Admin may change it, even from a department-scoped request.
      if (isEnabled !== undefined) {
        return NextResponse.json(
          { error: "Only a System Admin can enable/disable SLA tracking.", code: "missing_permission" },
          { status: 403 }
        );
      }
      if (Array.isArray(policies)) {
        for (const p of policies) {
          const priority = await prisma.ticketPriority.findUnique({
            where: { id: p.priorityId },
            select: { departmentId: true },
          });
          // A department-scoped caller may only set SLA hours for that
          // department's OWN priorities — never a global priority (which
          // applies to every department) and never another department's.
          if (!priority || priority.departmentId !== departmentId) {
            return NextResponse.json(
              { error: "That priority does not belong to this department.", code: "invalid_department_scope" },
              { status: 400 }
            );
          }
        }
      }
    } else {
      await requireAdmin();
      await prisma.slaSettings.upsert({
        where: { id: "sla-settings-singleton" },
        update: { isEnabled },
        create: { id: "sla-settings-singleton", isEnabled },
      });
    }

    if (Array.isArray(policies)) {
      await Promise.all(
        policies.map((p: { priorityId: string; firstResponseHours: number; resolutionHours: number }) =>
          prisma.slaPolicy.upsert({
            where: { priorityId: p.priorityId },
            update: {
              firstResponseHours: Number(p.firstResponseHours),
              resolutionHours: Number(p.resolutionHours),
            },
            create: {
              priorityId: p.priorityId,
              firstResponseHours: Number(p.firstResponseHours),
              resolutionHours: Number(p.resolutionHours),
            },
          })
        )
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
  }
}

// DELETE /api/admin/sla?priorityId=X -> resets that priority's SLA hours
// back to the built-in default (8h/48h, the same fallback the GET route
// already applies when no SlaPolicy row exists) by removing the SlaPolicy
// row. Never touches the TicketPriority itself — this is "reset to
// default," not "delete this priority."
export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const priorityId = searchParams.get("priorityId");
    if (!priorityId) return NextResponse.json({ error: "priorityId required" }, { status: 400 });

    const priority = await prisma.ticketPriority.findUnique({ where: { id: priorityId }, select: { departmentId: true } });
    if (!priority) return NextResponse.json({ error: "Priority not found", code: "item_not_found" }, { status: 404 });

    if (priority.departmentId) {
      await requireDepartmentPermission(priority.departmentId, "sla.delete");
    } else {
      await requireAdmin();
    }

    const existingPolicy = await prisma.slaPolicy.findUnique({ where: { priorityId } });
    if (!existingPolicy) {
      return NextResponse.json({ error: "No custom SLA policy to remove for this priority.", code: "item_not_found" }, { status: 404 });
    }

    await prisma.slaPolicy.delete({ where: { priorityId } });
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    return NextResponse.json({ error: "Internal error", code: "internal_error" }, { status: 500 });
  }
}
