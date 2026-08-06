import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireDepartmentPermission, hasPermission } from "@/lib/permissions";
import { updateDepartmentSchema } from "@/lib/validations";
import { updateDepartment, setDepartmentActive } from "@/lib/services/department-service";
import { invalidateOrganizationTreeCache } from "@/lib/services/organization-tree-service";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await requireDepartmentPermission(id, "department.manageSettings");

    const department = await prisma.department.findUnique({
      where: { id },
      include: {
        businessUnit: { select: { id: true, name: true } },
        _count: { select: { users: true, memberships: true, tickets: true, projects: true, categories: true } },
      },
    });
    if (!department) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return NextResponse.json(department);
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const data = updateDepartmentSchema.parse(body);

    // Activate/deactivate is a structural, global-impact action, gated by
    // the global department.update permission (Administrator has it via the
    // usual hasPermission bypass; grantable to others from Roles &
    // Permissions) — everything else (name/slug/description) a Department
    // Admin can also do for their own department via the existing
    // department-scoped department.manageSettings gate.
    if (data.isActive !== undefined) {
      const session = await requireAuth();
      const allowed = await hasPermission(session.user.role, "department.update", session.user.customRoleId);
      if (!allowed) return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    } else {
      await requireDepartmentPermission(id, "department.manageSettings");
    }

    // Moving a department to a different Business Unit changes its whole
    // organizational ancestry (Company -> BusinessUnit -> Department) — a
    // structural, cross-cutting change, not a per-department "setting."
    // department.manageSettings (which CAN be department-scoped, e.g. a
    // DEPARTMENT_ADMIN membership) is not enough on its own: the caller must
    // hold the SAME global permissions the Business Unit admin API itself
    // requires (department.update AND businessUnit.update — "manage both
    // the Department and the target Business Unit"), regardless of which
    // gate above already passed. Cross-company moves are allowed by policy
    // (no separate company-level permission tier exists in this app), but
    // still require these same two permissions — never a bare valid id.
    if (data.businessUnitId !== undefined) {
      const session = await requireAuth();
      const [canUpdateDepartment, canUpdateBusinessUnit] = await Promise.all([
        hasPermission(session.user.role, "department.update", session.user.customRoleId),
        hasPermission(session.user.role, "businessUnit.update", session.user.customRoleId),
      ]);
      if (!canUpdateDepartment || !canUpdateBusinessUnit) {
        return NextResponse.json(
          { error: "You do not have permission to change this department's business unit.", code: "missing_permission" },
          { status: 403 }
        );
      }

      const targetBusinessUnit = await prisma.businessUnit.findUnique({ where: { id: data.businessUnitId }, select: { id: true } });
      if (!targetBusinessUnit) {
        return NextResponse.json(
          { error: "The selected business unit does not exist.", code: "business_unit_not_found", field: "businessUnitId" },
          { status: 400 }
        );
      }
    }

    const existingDepartment = await prisma.department.findUnique({ where: { id }, select: { id: true } });
    if (!existingDepartment) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (data.slug !== undefined) {
      const existing = await prisma.department.findFirst({
        where: { slug: data.slug, NOT: { id } },
        select: { id: true },
      });
      if (existing) {
        return NextResponse.json({ error: "A department with this slug already exists." }, { status: 409 });
      }
    }

    const { isActive, ...rest } = data;
    if (Object.keys(rest).length > 0) {
      await updateDepartment(id, rest);
      // Same businessUnitId submitted again (no actual ancestry change) is a
      // safe, idempotent no-op either way — invalidating the (already-correct)
      // cache here costs nothing and keeps this branch simple, never
      // conditional on whether the value actually differed from before.
      if (data.businessUnitId !== undefined) {
        // A full Microsoft organization sync is never triggered for this —
        // this is a local hierarchy edit only; invalidateOrganizationTreeCache()
        // just clears the in-process 5-minute tree cache (lib/services/
        // organization-tree-service.ts) so the org chart and any
        // BusinessUnit-scoped list reflects the new ancestry on next read,
        // instead of possibly serving a stale grouping for up to 5 minutes.
        invalidateOrganizationTreeCache();
      }
    }
    if (isActive !== undefined) {
      await setDepartmentActive(id, isActive);
    }

    const withRelations = await prisma.department.findUnique({
      where: { id },
      include: { businessUnit: { select: { id: true, name: true, company: { select: { id: true, name: true } } } } },
    });
    if (!withRelations) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return NextResponse.json(withRelations);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (error?.code === "P2025") return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    // Deletion is gated by the global department.delete permission
    // (Administrator via the usual bypass; grantable to others from Roles &
    // Permissions) — a structural/destructive action, unlike settings/member
    // management which a Department Admin can also do for their own department.
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "department.delete", session.user.customRoleId);
    if (!allowed) return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });

    const department = await prisma.department.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            users: true,
            memberships: true,
            tickets: true,
            projects: true,
            activities: true,
            categories: true,
            subDepartments: true,
            microsoftMappings: true,
          },
        },
      },
    });
    if (!department) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const counts = department._count;
    const totalDependents = Object.values(counts).reduce((sum, n) => sum + n, 0);
    if (totalDependents > 0) {
      const parts = Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([key, n]) => `${n} ${key}`)
        .join(", ");
      return NextResponse.json(
        { error: `Cannot delete a department that still has ${parts}. Deactivate it instead.` },
        { status: 409 }
      );
    }

    await prisma.department.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
