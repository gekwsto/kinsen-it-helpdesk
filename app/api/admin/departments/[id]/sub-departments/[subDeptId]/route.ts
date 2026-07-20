import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireDepartmentPermission } from "@/lib/permissions";
import { updateSubDepartmentSchema } from "@/lib/validations";
import { updateSubDepartment, setSubDepartmentActive } from "@/lib/services/sub-department-service";

async function loadScoped(id: string, subDeptId: string) {
  const subDepartment = await prisma.subDepartment.findUnique({ where: { id: subDeptId } });
  if (!subDepartment || subDepartment.departmentId !== id) return null;
  return subDepartment;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; subDeptId: string }> }
) {
  try {
    const { id, subDeptId } = await params;
    await requireDepartmentPermission(id, "subdepartment.update");

    const subDepartment = await loadScoped(id, subDeptId);
    if (!subDepartment) return NextResponse.json({ error: "Not found", code: "invalid_subdepartment" }, { status: 404 });

    const body = await req.json();
    const data = updateSubDepartmentSchema.parse(body);

    if (data.name !== undefined) {
      const existing = await prisma.subDepartment.findFirst({
        where: { departmentId: id, name: data.name, NOT: { id: subDeptId } },
      });
      if (existing) {
        return NextResponse.json(
          { error: "A sub-department with this name already exists in this department.", code: "invalid_subdepartment" },
          { status: 409 }
        );
      }
    }

    const { isActive, ...rest } = data;
    if (Object.keys(rest).length > 0) {
      await updateSubDepartment(subDeptId, rest);
    }
    if (isActive !== undefined) {
      await setSubDepartmentActive(subDeptId, isActive);
    }

    const updated = await prisma.subDepartment.findUnique({ where: { id: subDeptId } });
    return NextResponse.json(updated);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

/**
 * Mirrors the Department DELETE route's own pattern: hard-delete only if
 * zero dependents (memberships/tickets/projects/activities), otherwise
 * reject and point at soft-disable instead — preserves history rather than
 * silently orphaning linked entities.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; subDeptId: string }> }
) {
  try {
    const { id, subDeptId } = await params;
    await requireDepartmentPermission(id, "subdepartment.delete");

    const subDepartment = await prisma.subDepartment.findUnique({
      where: { id: subDeptId },
      include: {
        _count: { select: { memberships: true, tickets: true, projects: true, activities: true } },
      },
    });
    if (!subDepartment || subDepartment.departmentId !== id) {
      return NextResponse.json({ error: "Not found", code: "invalid_subdepartment" }, { status: 404 });
    }

    const counts = subDepartment._count;
    const totalDependents = Object.values(counts).reduce((sum, n) => sum + n, 0);
    if (totalDependents > 0) {
      const parts = Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([key, n]) => `${n} ${key}`)
        .join(", ");
      return NextResponse.json(
        { error: `Cannot delete a sub-department that still has ${parts}. Disable it instead.`, code: "invalid_subdepartment" },
        { status: 409 }
      );
    }

    await prisma.subDepartment.delete({ where: { id: subDeptId } });
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
