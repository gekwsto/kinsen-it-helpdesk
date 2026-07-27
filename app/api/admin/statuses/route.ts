import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireAnyDepartmentPermission, requireDepartmentPermission } from "@/lib/permissions";
import { createStatusSchema, updateStatusSchema } from "@/lib/validations";
import { buildStatusWhere, isLastActiveDefaultStatusInDepartment } from "@/lib/services/department-scope-service";
import { apiError, zodErrorResponse, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

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
    if (error.message === "Unauthorized") return unauthorizedResponse();
    return forbiddenResponse();
  }
}

export async function POST(req: NextRequest) {
  let attemptedName: string | undefined;
  try {
    const body = await req.json();
    const parsed = createStatusSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);
    const { departmentId, ...data } = parsed.data;
    attemptedName = data.name;

    // Every status belongs to exactly one department now — there is no more
    // global/shared status. requireDepartmentPermission already bypasses for
    // System Admin, so this covers both "admin creating for any department"
    // and "department admin/manager creating for their own" in one call.
    if (!departmentId) {
      return NextResponse.json(apiError("department_required", "A department is required.", { field: "departmentId" }), { status: 400 });
    }

    try {
      await requireDepartmentPermission(departmentId, "status.create");
    } catch (error: any) {
      if (error.message === "Unauthorized") return unauthorizedResponse();
      return forbiddenResponse("You do not have permission to create statuses in this department.");
    }

    // Checked explicitly (rather than letting a bad departmentId fall
    // through to a raw P2003 foreign-key failure at insert time) so an
    // invalid/deleted department id always gets a specific, actionable
    // message instead of a generic "Internal error".
    const department = await prisma.department.findUnique({ where: { id: departmentId }, select: { id: true } });
    if (!department) {
      return NextResponse.json(apiError("invalid_department", "The selected department does not exist.", { field: "departmentId" }), { status: 400 });
    }

    // Only one ACTIVE default status is meaningful per department (see
    // resolveDefaultStatusId's own doc comment — "should never happen by
    // design") — a second one is ambiguous, not a real configuration.
    // Removing the LAST one is already blocked elsewhere (PATCH/DELETE);
    // this is the symmetric guard on the CREATE side.
    if (data.isDefault) {
      const existingDefault = await prisma.ticketStatus.findFirst({
        where: { departmentId, isDefault: true, isActive: true },
        select: { name: true },
      });
      if (existingDefault) {
        return NextResponse.json(
          apiError(
            "duplicate_default_status",
            `"${existingDefault.name}" is already the default status for this department — unset it before making another status the default.`,
            { field: "isDefault" }
          ),
          { status: 409 }
        );
      }
    }

    const status = await prisma.ticketStatus.create({ data: { ...data, departmentId } });
    return NextResponse.json(status, { status: 201 });
  } catch (error: any) {
    if (error.code === "P2002") {
      const name = attemptedName ? `"${attemptedName}"` : "This name";
      return NextResponse.json(
        apiError("duplicate_status_name", `${name} already exists as a status in this department.`, { field: "name" }),
        { status: 409 }
      );
    }
    if (error.code === "P2003") {
      return NextResponse.json(apiError("invalid_department", "The selected department does not exist.", { field: "departmentId" }), { status: 400 });
    }
    return internalErrorResponse();
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const raw = await req.json();
    // departmentId is deliberately never accepted here — moving a status
    // between departments isn't supported by this endpoint.
    const { id, departmentId: _ignored, ...body } = raw;
    if (!id) return NextResponse.json(apiError("invalid_payload", "A status id is required."), { status: 400 });

    const existing = await prisma.ticketStatus.findUnique({ where: { id } });
    if (!existing) return NextResponse.json(apiError("item_not_found", "This status no longer exists."), { status: 404 });

    try {
      await requireDepartmentPermission(existing.departmentId, "status.edit");
    } catch (error: any) {
      if (error.message === "Unauthorized") return unauthorizedResponse();
      return forbiddenResponse("You do not have permission to edit statuses in this department.");
    }

    // Partial validation of just the fields being changed — reuses the same
    // schema's field rules (name length, color format) so PATCH and POST can
    // never disagree on what's valid, and a bad value here surfaces the same
    // specific, field-scoped error.
    const parsed = updateStatusSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);
    const data = parsed.data;

    const removesDefault =
      existing.isDefault &&
      existing.isActive &&
      ((data.isDefault === false) || (data.isActive === false));
    if (removesDefault && (await isLastActiveDefaultStatusInDepartment(id, existing.departmentId))) {
      return NextResponse.json(
        apiError(
          "system_item_locked",
          "This is the only active default status for this department — configure another default before changing this one.",
          { field: data.isDefault === false ? "isDefault" : "isActive" }
        ),
        { status: 409 }
      );
    }

    const setsNewDefault = data.isDefault === true && !(existing.isDefault && existing.isActive);
    if (setsNewDefault) {
      const existingDefault = await prisma.ticketStatus.findFirst({
        where: { departmentId: existing.departmentId, isDefault: true, isActive: true, NOT: { id } },
        select: { name: true },
      });
      if (existingDefault) {
        return NextResponse.json(
          apiError(
            "duplicate_default_status",
            `"${existingDefault.name}" is already the default status for this department — unset it before making another status the default.`,
            { field: "isDefault" }
          ),
          { status: 409 }
        );
      }
    }

    const status = await prisma.ticketStatus.update({ where: { id }, data });
    return NextResponse.json(status);
  } catch (error: any) {
    if (error.code === "P2002") {
      return NextResponse.json(apiError("duplicate_status_name", "A status with this name already exists in this department.", { field: "name" }), { status: 409 });
    }
    return internalErrorResponse();
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json(apiError("invalid_payload", "A status id is required."), { status: 400 });

    const existing = await prisma.ticketStatus.findUnique({
      where: { id },
      include: { _count: { select: { tickets: true } } },
    });
    if (!existing) return NextResponse.json(apiError("item_not_found", "This status no longer exists."), { status: 404 });

    try {
      await requireDepartmentPermission(existing.departmentId, "status.delete");
    } catch (error: any) {
      if (error.message === "Unauthorized") return unauthorizedResponse();
      return forbiddenResponse("You do not have permission to delete statuses in this department.");
    }

    if (existing.isDefault && existing.isActive && (await isLastActiveDefaultStatusInDepartment(id, existing.departmentId))) {
      return NextResponse.json(
        apiError("system_item_locked", "This is the only active default status for this department — configure another default before deleting this one."),
        { status: 409 }
      );
    }

    if (existing._count.tickets > 0) {
      return NextResponse.json(
        apiError("item_in_use", `This status is used by ${existing._count.tickets} ticket(s) and cannot be deleted. Deactivate it instead.`),
        { status: 409 }
      );
    }

    await prisma.ticketStatus.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.code === "P2003") {
      return NextResponse.json(apiError("item_in_use", "This status is still referenced and cannot be deleted. Deactivate it instead."), { status: 409 });
    }
    return internalErrorResponse();
  }
}
