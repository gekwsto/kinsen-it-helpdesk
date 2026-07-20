import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireDepartmentPermission, hasPermission } from "@/lib/permissions";
import { updateDepartmentSchema } from "@/lib/validations";
import { updateDepartment, setDepartmentActive } from "@/lib/services/department-service";

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
    }
    if (isActive !== undefined) {
      await setDepartmentActive(id, isActive);
    }

    const withRelations = await prisma.department.findUnique({
      where: { id },
      include: { businessUnit: { select: { id: true, name: true } } },
    });
    if (!withRelations) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return NextResponse.json(withRelations);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
