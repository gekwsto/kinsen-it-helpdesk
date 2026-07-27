import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireAnyDepartmentPermission, requireDepartmentPermission } from "@/lib/permissions";
import { createCancelReasonSchema, updateCancelReasonSchema } from "@/lib/validations";
import { buildCancelReasonWhere } from "@/lib/services/department-scope-service";
import { apiError, zodErrorResponse, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

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
    if (error.message === "Unauthorized") return unauthorizedResponse();
    return forbiddenResponse();
  }
}

export async function POST(req: NextRequest) {
  let attemptedName: string | undefined;
  try {
    const body = await req.json();
    const parsed = createCancelReasonSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);
    const data = parsed.data;
    attemptedName = data.name;

    if (data.departmentId) {
      const department = await prisma.department.findUnique({ where: { id: data.departmentId }, select: { id: true } });
      if (!department) {
        return NextResponse.json(apiError("invalid_department", "The selected department does not exist.", { field: "departmentId" }), { status: 400 });
      }
      try {
        await requireDepartmentPermission(data.departmentId, "cancelReason.create");
      } catch (error: any) {
        if (error.message === "Unauthorized") return unauthorizedResponse();
        return forbiddenResponse("You do not have permission to create cancel reasons in this department.");
      }
    } else {
      // Global reason (departmentId omitted/null) — System Admin only.
      try {
        await requireAdmin();
      } catch (error: any) {
        if (error.message === "Unauthorized") return unauthorizedResponse();
        return forbiddenResponse("Only a System Admin can create a global cancel reason.");
      }
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
        return NextResponse.json(apiError("duplicate_cancel_reason_name", `"${data.name}" already exists as a global cancel reason.`, { field: "name" }), { status: 409 });
      }
    }

    const reason = await prisma.ticketCancelReason.create({ data });
    return NextResponse.json(reason, { status: 201 });
  } catch (error: any) {
    if (error.code === "P2002") {
      const name = attemptedName ? `"${attemptedName}"` : "This name";
      return NextResponse.json(apiError("duplicate_cancel_reason_name", `${name} already exists as a cancel reason in this department.`, { field: "name" }), { status: 409 });
    }
    if (error.code === "P2003") {
      return NextResponse.json(apiError("invalid_department", "The selected department does not exist.", { field: "departmentId" }), { status: 400 });
    }
    return internalErrorResponse();
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const parsedBody = updateCancelReasonSchema.safeParse(body);
    if (!parsedBody.success) return zodErrorResponse(parsedBody.error);
    const { id, ...data } = parsedBody.data;

    const existing = await prisma.ticketCancelReason.findUnique({ where: { id }, select: { departmentId: true } });
    if (!existing) return NextResponse.json(apiError("item_not_found", "This cancel reason no longer exists."), { status: 404 });

    try {
      if (existing.departmentId) {
        await requireDepartmentPermission(existing.departmentId, "cancelReason.edit");
      } else {
        await requireAdmin();
      }
    } catch (error: any) {
      if (error.message === "Unauthorized") return unauthorizedResponse();
      return forbiddenResponse("You do not have permission to edit this cancel reason.");
    }

    if (data.name) {
      const dupe = await prisma.ticketCancelReason.findFirst({
        where: { departmentId: existing.departmentId, name: data.name, NOT: { id } },
      });
      if (dupe) {
        return NextResponse.json(apiError("duplicate_cancel_reason_name", `A cancel reason named "${data.name}" already exists in this scope.`, { field: "name" }), { status: 409 });
      }
    }

    const updated = await prisma.ticketCancelReason.update({ where: { id }, data });
    return NextResponse.json(updated);
  } catch (error: any) {
    if (error.code === "P2002") {
      return NextResponse.json(apiError("duplicate_cancel_reason_name", "A cancel reason with this name already exists in this scope.", { field: "name" }), { status: 409 });
    }
    return internalErrorResponse();
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json(apiError("invalid_payload", "A cancel reason id is required."), { status: 400 });

    const reason = await prisma.ticketCancelReason.findUnique({
      where: { id },
      include: { _count: { select: { tickets: true } } },
    });
    if (!reason) return NextResponse.json(apiError("item_not_found", "This cancel reason no longer exists."), { status: 404 });

    try {
      if (reason.departmentId) {
        await requireDepartmentPermission(reason.departmentId, "cancelReason.delete");
      } else {
        await requireAdmin();
      }
    } catch (error: any) {
      if (error.message === "Unauthorized") return unauthorizedResponse();
      return forbiddenResponse("You do not have permission to delete this cancel reason.");
    }

    if (reason._count.tickets > 0) {
      return NextResponse.json(
        apiError("item_in_use", `This cancel reason is used by ${reason._count.tickets} ticket${reason._count.tickets > 1 ? "s" : ""} and cannot be deleted. Deactivate it instead.`),
        { status: 409 }
      );
    }

    await prisma.ticketCancelReason.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.code === "P2003") {
      return NextResponse.json(apiError("item_in_use", "This cancel reason is still referenced and cannot be deleted. Deactivate it instead."), { status: 409 });
    }
    return internalErrorResponse();
  }
}
