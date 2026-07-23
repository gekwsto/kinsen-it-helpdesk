import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireAnyDepartmentPermission, requireDepartmentPermission } from "@/lib/permissions";
import { createPrioritySchema } from "@/lib/validations";
import { buildPriorityWhere } from "@/lib/services/department-scope-service";

const PRIORITY_PERMISSION_KEYS = ["priority.create", "priority.edit", "priority.delete"];

// GET /api/admin/priorities               -> every priority (System Admin only, unchanged global view)
// GET /api/admin/priorities?departmentId=X -> that department's own priorities —
//   System Admin or anyone holding a priority.* permission in X.
export async function GET(req: NextRequest) {
  try {
    const departmentId = req.nextUrl.searchParams.get("departmentId");

    if (departmentId) {
      await requireAnyDepartmentPermission(departmentId, PRIORITY_PERMISSION_KEYS);
      const priorities = await prisma.ticketPriority.findMany({
        where: buildPriorityWhere(departmentId),
        orderBy: { level: "desc" },
        include: { _count: { select: { tickets: true } }, department: { select: { id: true, name: true } } },
      });
      return NextResponse.json(priorities);
    }

    await requireAdmin();
    const priorities = await prisma.ticketPriority.findMany({
      orderBy: { level: "desc" },
      include: { _count: { select: { tickets: true } }, department: { select: { id: true, name: true } } },
    });
    return NextResponse.json(priorities);
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { departmentId, ...data } = createPrioritySchema.parse(body);

    // Every priority belongs to exactly one department now — there is no
    // more global/shared priority. requireDepartmentPermission already
    // bypasses for System Admin, so this covers both "admin creating for
    // any department" and "department admin/manager creating for their own"
    // in one call.
    if (!departmentId) {
      return NextResponse.json({ error: "A department is required.", code: "department_required" }, { status: 400 });
    }
    await requireDepartmentPermission(departmentId, "priority.create");

    const priority = await prisma.ticketPriority.create({ data: { ...data, departmentId } });
    return NextResponse.json(priority, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    if (error.code === "P2002") {
      return NextResponse.json({ error: "A priority with this name already exists in this department.", code: "duplicate_name" }, { status: 409 });
    }
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    return NextResponse.json({ error: "Internal error", code: "internal_error" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    // departmentId is deliberately never accepted here — moving a priority
    // between departments isn't supported by this endpoint.
    const { id, departmentId: _ignored, ...data } = body;
    if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 });

    const existing = await prisma.ticketPriority.findUnique({ where: { id }, select: { departmentId: true } });
    if (!existing) return NextResponse.json({ error: "Not found", code: "item_not_found" }, { status: 404 });

    await requireDepartmentPermission(existing.departmentId, "priority.edit");

    const priority = await prisma.ticketPriority.update({ where: { id }, data });
    return NextResponse.json(priority);
  } catch (error: any) {
    if (error.code === "P2002") {
      return NextResponse.json({ error: "A priority with this name already exists in this department.", code: "duplicate_name" }, { status: 409 });
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

    const existing = await prisma.ticketPriority.findUnique({
      where: { id },
      include: { _count: { select: { tickets: true } } },
    });
    if (!existing) return NextResponse.json({ error: "Not found", code: "item_not_found" }, { status: 404 });

    await requireDepartmentPermission(existing.departmentId, "priority.delete");

    if (existing._count.tickets > 0) {
      return NextResponse.json(
        {
          error: `This priority is used by ${existing._count.tickets} ticket(s) and cannot be deleted. Deactivate it instead.`,
          code: "item_in_use",
        },
        { status: 409 }
      );
    }

    // SlaPolicy.priorityId has onDelete: Cascade, so an unused priority's
    // SLA override (if any) is removed automatically and atomically here —
    // no separate step needed, and never an orphaned SlaPolicy row.
    await prisma.ticketPriority.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    if (error.code === "P2003") return NextResponse.json({ error: "This priority is still referenced and cannot be deleted. Deactivate it instead.", code: "item_in_use" }, { status: 409 });
    return NextResponse.json({ error: "Internal error", code: "internal_error" }, { status: 500 });
  }
}
