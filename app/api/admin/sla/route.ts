import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireAnyDepartmentPermission, requireDepartmentPermission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { buildPriorityWhere } from "@/lib/services/department-scope-service";
import { resolveSlaHoursFromRelation } from "@/lib/services/sla-policy";
import { STARTER_SLA_HOURS } from "@/lib/services/config-starter-data";
import { logDepartmentConfigHealth } from "@/lib/services/config-health";
import { apiError, unauthorizedResponse, forbiddenResponse } from "@/lib/api-errors";

const SLA_PERMISSION_KEYS = ["sla.create", "sla.edit", "sla.delete"];

// GET /api/admin/sla               -> every priority + policy (System Admin only, unchanged global view)
// GET /api/admin/sla?departmentId=X -> strictly that department's own priorities —
//   System Admin or anyone holding an sla.* permission in X.
// Intentionally includes DISABLED priorities too (not just active) — this
// is the admin management view, where a disabled level must stay visible
// (to re-enable, edit its historical hours, or safely delete it). Ticket-
// creation dropdowns elsewhere filter to isActive:true on their own.
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
        where: departmentId ? buildPriorityWhere(departmentId) : undefined,
        orderBy: { level: "desc" },
        include: { slaPolicy: true, department: { select: { id: true, name: true } }, _count: { select: { tickets: true } } },
      }),
    ]);

    return NextResponse.json({
      isEnabled: settings?.isEnabled ?? false,
      priorities: priorities.map((p) => {
        const resolution = resolveSlaHoursFromRelation(p.slaPolicy, p.id);
        return {
          id: p.id,
          name: p.name,
          color: p.color,
          level: p.level,
          isActive: p.isActive,
          departmentId: p.departmentId,
          department: p.department,
          // null means no SlaPolicy row exists — the UI MUST render "SLA
          // not configured", never fabricate 8h/48h as if it were real data.
          firstResponseHours: resolution.ok ? resolution.hours.firstResponseHours : null,
          resolutionHours: resolution.ok ? resolution.hours.resolutionHours : null,
          hasPolicy: resolution.ok,
          ticketCount: p._count.tickets,
        };
      }),
    });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    return forbiddenResponse();
  }
}

// PUT /api/admin/sla -> three distinct actions, disambiguated by payload
// shape (never conflated):
//   { isEnabled }                     -> global SLA-tracking feature flag (System Admin only)
//   { departmentId, policies: [...] } -> bulk-save REAL hours for that department's own priorities (Edit)
//   { departmentId, action: "reset", priorityId } -> Reset ONE priority's hours back to
//     STARTER_SLA_HOURS — explicitly named "reset", never a bare DELETE
//     verb standing in for it. Every priority always has exactly one
//     SlaPolicy row (full backfill + ensureSlaPolicyForPriority on every
//     create), so this always UPSERTs rather than ever removing the row —
//     a normal "Reset" click can never manufacture a configuration gap.
//     Real deletion of a level (priority + its policy) is a completely
//     different, more destructive action — see DELETE /api/admin/priorities,
//     which already blocks it while tickets reference the priority.
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { departmentId, isEnabled, policies, action, priorityId } = body;

    if (departmentId && action === "reset") {
      try {
        await requireDepartmentPermission(departmentId, "sla.edit");
      } catch (error: any) {
        if (error.message === "Unauthorized") return unauthorizedResponse();
        return forbiddenResponse("You do not have permission to reset SLA hours in this department.");
      }
      if (!priorityId) return NextResponse.json(apiError("invalid_payload", "priorityId is required."), { status: 400 });
      const priority = await prisma.ticketPriority.findUnique({ where: { id: priorityId }, select: { departmentId: true } });
      if (!priority) return NextResponse.json(apiError("item_not_found", "This priority no longer exists."), { status: 404 });
      if (priority.departmentId !== departmentId) {
        return NextResponse.json(apiError("cross_department_denied", "That priority does not belong to this department.", { field: "priorityId" }), { status: 400 });
      }
      await prisma.slaPolicy.upsert({
        where: { priorityId },
        update: { ...STARTER_SLA_HOURS },
        create: { priorityId, ...STARTER_SLA_HOURS },
      });
      await logDepartmentConfigHealth(prisma, departmentId, "sla reset");
      return NextResponse.json({ ok: true, firstResponseHours: STARTER_SLA_HOURS.firstResponseHours, resolutionHours: STARTER_SLA_HOURS.resolutionHours });
    }

    if (departmentId) {
      try {
        await requireDepartmentPermission(departmentId, "sla.edit");
      } catch (error: any) {
        if (error.message === "Unauthorized") return unauthorizedResponse();
        return forbiddenResponse("You do not have permission to edit SLA hours in this department.");
      }
      // The global enable/disable switch is a system-wide feature flag
      // (SlaSettings is a singleton, not department-scoped) — only a System
      // Admin may change it, even from a department-scoped request.
      if (isEnabled !== undefined) {
        return forbiddenResponse("Only a System Admin can enable/disable SLA tracking.");
      }
      if (Array.isArray(policies)) {
        for (const p of policies) {
          const priority = await prisma.ticketPriority.findUnique({
            where: { id: p.priorityId },
            select: { departmentId: true },
          });
          // A department-scoped caller may only set SLA hours for that
          // department's OWN priorities — never another department's.
          if (!priority || priority.departmentId !== departmentId) {
            return NextResponse.json(apiError("cross_department_denied", "That priority does not belong to this department.", { field: "priorityId" }), { status: 400 });
          }
        }
      }
    } else {
      try {
        await requireAdmin();
      } catch (error: any) {
        if (error.message === "Unauthorized") return unauthorizedResponse();
        return forbiddenResponse("Only a System Admin can enable/disable SLA tracking.");
      }
      await prisma.slaSettings.upsert({
        where: { id: "sla-settings-singleton" },
        update: { isEnabled },
        create: { id: "sla-settings-singleton", isEnabled },
      });
    }

    if (Array.isArray(policies)) {
      for (const p of policies) {
        const first = Number(p.firstResponseHours);
        const resolution = Number(p.resolutionHours);
        if (!Number.isInteger(first) || first < 1 || !Number.isInteger(resolution) || resolution < 1) {
          return NextResponse.json(apiError("invalid_sla_hours", "SLA hours must be whole numbers of at least 1.", { field: "firstResponseHours" }), { status: 400 });
        }
      }
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

    if (departmentId) {
      await logDepartmentConfigHealth(prisma, departmentId, "sla PUT");
    }
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    return forbiddenResponse();
  }
}
