import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireAnyDepartmentPermission, requireDepartmentPermission } from "@/lib/permissions";
import { createStatusSchema } from "@/lib/validations";
import { buildStatusWhere, isLastActiveDefaultStatusInDepartment } from "@/lib/services/department-scope-service";

const STATUS_PERMISSION_KEYS = ["status.create", "status.edit", "status.delete"];

// GET /api/admin/statuses               -> every status (System Admin only, unchanged global view)
// GET /api/admin/statuses?departmentId=X -> that department's own statuses —
//   System Admin or anyone holding a status.* permission in X.
export async function GET(req: NextRequest) {
  try {
    const departmentId = req.nextUrl.searchParams.get("departmentId");

    if (departmentId) {
      await requireAnyDepartmentPermission(departmentId, STATUS_PERMISSION_KEYS);
      const statuses = await prisma.ticketStatus.findMany({
        where: buildStatusWhere(departmentId),
        orderBy: { order: "asc" },
        include: { _count: { select: { tickets: true } }, department: { select: { id: true, name: true } } },
      });
      return NextResponse.json(statuses);
    }

    await requireAdmin();
    const statuses = await prisma.ticketStatus.findMany({
      orderBy: { order: "asc" },
      include: { _count: { select: { tickets: true } }, department: { select: { id: true, name: true } } },
    });
    return NextResponse.json(statuses);
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { departmentId, ...data } = createStatusSchema.parse(body);

    // Every status belongs to exactly one department now — there is no more
    // global/shared status. requireDepartmentPermission already bypasses for
    // System Admin, so this covers both "admin creating for any department"
    // and "department admin/manager creating for their own" in one call.
    if (!departmentId) {
      return NextResponse.json({ error: "A department is required.", code: "department_required" }, { status: 400 });
    }
    await requireDepartmentPermission(departmentId, "status.create");

    const status = await prisma.ticketStatus.create({ data: { ...data, departmentId } });
    return NextResponse.json(status, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    if (error.code === "P2002") {
      return NextResponse.json({ error: "A status with this name already exists in this department.", code: "duplicate_name" }, { status: 409 });
    }
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    return NextResponse.json({ error: "Internal error", code: "internal_error" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    // departmentId is deliberately never accepted here — moving a status
    // between departments isn't supported by this endpoint.
    const { id, departmentId: _ignored, ...data } = body;
    if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 });

    const existing = await prisma.ticketStatus.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Not found", code: "item_not_found" }, { status: 404 });

    await requireDepartmentPermission(existing.departmentId, "status.edit");

    const removesDefault =
      existing.isDefault &&
      existing.isActive &&
      ((data.isDefault === false) || (data.isActive === false));
    if (removesDefault && (await isLastActiveDefaultStatusInDepartment(id, existing.departmentId))) {
      return NextResponse.json(
        { error: "This is the only active default status for this department — configure another default before changing this one.", code: "system_item_locked" },
        { status: 409 }
      );
    }

    const status = await prisma.ticketStatus.update({ where: { id }, data });
    return NextResponse.json(status);
  } catch (error: any) {
    if (error.code === "P2002") {
      return NextResponse.json({ error: "A status with this name already exists in this department.", code: "duplicate_name" }, { status: 409 });
    }
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    return NextResponse.json({ error: "Internal error", code: "internal_error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 });

    const existing = await prisma.ticketStatus.findUnique({
      where: { id },
      include: { _count: { select: { tickets: true } } },
    });
    if (!existing) return NextResponse.json({ error: "Not found", code: "item_not_found" }, { status: 404 });

    await requireDepartmentPermission(existing.departmentId, "status.delete");

    if (existing.isDefault && existing.isActive && (await isLastActiveDefaultStatusInDepartment(id, existing.departmentId))) {
      return NextResponse.json(
        { error: "This is the only active default status for this department — configure another default before deleting this one.", code: "system_item_locked" },
        { status: 409 }
      );
    }

    if (existing._count.tickets > 0) {
      return NextResponse.json(
        {
          error: `This status is used by ${existing._count.tickets} ticket(s) and cannot be deleted. Deactivate it instead.`,
          code: "item_in_use",
        },
        { status: 409 }
      );
    }

    await prisma.ticketStatus.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    if (error.code === "P2003") return NextResponse.json({ error: "This status is still referenced and cannot be deleted. Deactivate it instead.", code: "item_in_use" }, { status: 409 });
    return NextResponse.json({ error: "Internal error", code: "internal_error" }, { status: 500 });
  }
}
