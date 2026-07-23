import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireAnyDepartmentPermission, requireDepartmentPermission } from "@/lib/permissions";
import { createCancelReasonSchema, updateCancelReasonSchema } from "@/lib/validations";
import { buildCancelReasonWhere } from "@/lib/services/department-scope-service";

const CANCEL_REASON_PERMISSION_KEYS = ["cancelReason.create", "cancelReason.edit", "cancelReason.delete"];

// GET /api/admin/cancel-reasons               -> every reason (System Admin only, unchanged global view)
// GET /api/admin/cancel-reasons?departmentId=X -> that department's own reasons
//   (+ global ones) — System Admin or anyone holding a cancelReason.* permission in X.
export async function GET(req: NextRequest) {
  try {
    const departmentId = req.nextUrl.searchParams.get("departmentId");

    if (departmentId) {
      await requireAnyDepartmentPermission(departmentId, CANCEL_REASON_PERMISSION_KEYS);
      const reasons = await prisma.ticketCancelReason.findMany({
        where: buildCancelReasonWhere(departmentId),
        orderBy: { name: "asc" },
        include: { _count: { select: { tickets: true } }, department: { select: { id: true, name: true } } },
      });
      return NextResponse.json(reasons);
    }

    await requireAdmin();
    const reasons = await prisma.ticketCancelReason.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { tickets: true } }, department: { select: { id: true, name: true } } },
    });
    return NextResponse.json(reasons);
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const data = createCancelReasonSchema.parse(body);

    if (data.departmentId) {
      await requireDepartmentPermission(data.departmentId, "cancelReason.create");
    } else {
      // Global reason (departmentId omitted/null) — System Admin only.
      await requireAdmin();
      // The DB's @@unique([departmentId, name]) can't catch this case:
      // Postgres treats every NULL departmentId as distinct from every other
      // NULL, so two global reasons named identically wouldn't collide at
      // the constraint level. Checked explicitly instead — same pattern as
      // categories/priorities/statuses.
      const existingGlobal = await prisma.ticketCancelReason.findFirst({
        where: { departmentId: null, name: data.name },
        select: { id: true },
      });
      if (existingGlobal) {
        return NextResponse.json({ error: "A global cancel reason with this name already exists.", code: "duplicate_name" }, { status: 409 });
      }
    }

    const reason = await prisma.ticketCancelReason.create({ data });
    return NextResponse.json(reason, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    if (error.code === "P2002") {
      return NextResponse.json({ error: "A cancel reason with this name already exists in this department.", code: "duplicate_name" }, { status: 409 });
    }
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    return NextResponse.json({ error: "Internal error", code: "internal_error" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, ...data } = updateCancelReasonSchema.parse(body);

    const existing = await prisma.ticketCancelReason.findUnique({ where: { id }, select: { departmentId: true } });
    if (!existing) return NextResponse.json({ error: "Not found", code: "item_not_found" }, { status: 404 });

    if (existing.departmentId) {
      await requireDepartmentPermission(existing.departmentId, "cancelReason.edit");
    } else {
      await requireAdmin();
    }

    if (data.name) {
      const dupe = await prisma.ticketCancelReason.findFirst({
        where: { departmentId: existing.departmentId, name: data.name, NOT: { id } },
      });
      if (dupe) {
        return NextResponse.json({ error: "A cancel reason with this name already exists in this department.", code: "duplicate_name" }, { status: 409 });
      }
    }

    const updated = await prisma.ticketCancelReason.update({ where: { id }, data });
    return NextResponse.json(updated);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: "Invalid data" }, { status: 422 });
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

    const reason = await prisma.ticketCancelReason.findUnique({
      where: { id },
      include: { _count: { select: { tickets: true } } },
    });
    if (!reason) return NextResponse.json({ error: "Not found", code: "item_not_found" }, { status: 404 });

    if (reason.departmentId) {
      await requireDepartmentPermission(reason.departmentId, "cancelReason.delete");
    } else {
      await requireAdmin();
    }

    if (reason._count.tickets > 0) {
      return NextResponse.json(
        {
          error: `This cancel reason is used by ${reason._count.tickets} ticket${reason._count.tickets > 1 ? "s" : ""} and cannot be deleted. Deactivate it instead.`,
          code: "item_in_use",
        },
        { status: 409 }
      );
    }

    await prisma.ticketCancelReason.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    return NextResponse.json({ error: "Internal error", code: "internal_error" }, { status: 500 });
  }
}
