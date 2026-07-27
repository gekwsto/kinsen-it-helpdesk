import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireAnyDepartmentPermission, requireDepartmentPermission } from "@/lib/permissions";
import { createPrioritySchema, updatePrioritySchema } from "@/lib/validations";
import { buildPriorityWhere } from "@/lib/services/department-scope-service";
import { ensureSlaPolicyForPriority } from "@/lib/services/config-starter-data";
import { logDepartmentConfigHealth } from "@/lib/services/config-health";
import { apiError, zodErrorResponse, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

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
    if (error.message === "Unauthorized") return unauthorizedResponse();
    return forbiddenResponse();
  }
}

export async function POST(req: NextRequest) {
  let attemptedName: string | undefined;
  try {
    const body = await req.json();
    const parsed = createPrioritySchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);
    const { departmentId, ...data } = parsed.data;
    attemptedName = data.name;

    // Every priority belongs to exactly one department now — there is no
    // more global/shared priority. requireDepartmentPermission already
    // bypasses for System Admin, so this covers both "admin creating for
    // any department" and "department admin/manager creating for their own"
    // in one call.
    if (!departmentId) {
      return NextResponse.json(apiError("department_required", "A department is required.", { field: "departmentId" }), { status: 400 });
    }

    try {
      await requireDepartmentPermission(departmentId, "priority.create");
    } catch (error: any) {
      if (error.message === "Unauthorized") return unauthorizedResponse();
      return forbiddenResponse("You do not have permission to create priorities in this department.");
    }

    const department = await prisma.department.findUnique({ where: { id: departmentId }, select: { id: true } });
    if (!department) {
      return NextResponse.json(apiError("invalid_department", "The selected department does not exist.", { field: "departmentId" }), { status: 400 });
    }

    const priority = await prisma.ticketPriority.create({ data: { ...data, departmentId } });
    // Every priority always has real SLA hours to read (lib/services/sla-policy.ts
    // never guesses) — admin-created priorities get starter hours here, same as
    // seed/department-bootstrap priorities via ensurePriorityForDepartment.
    await ensureSlaPolicyForPriority(prisma, priority.id);
    await logDepartmentConfigHealth(prisma, departmentId, "priorities POST");
    return NextResponse.json(priority, { status: 201 });
  } catch (error: any) {
    if (error.code === "P2002") {
      const name = attemptedName ? `"${attemptedName}"` : "This name";
      return NextResponse.json(apiError("duplicate_priority_name", `${name} already exists as a priority in this department.`, { field: "name" }), { status: 409 });
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
    // departmentId is deliberately never accepted here — moving a priority
    // between departments isn't supported by this endpoint.
    const { id, departmentId: _ignored, ...body } = raw;
    if (!id) return NextResponse.json(apiError("invalid_payload", "A priority id is required."), { status: 400 });

    const existing = await prisma.ticketPriority.findUnique({ where: { id }, select: { departmentId: true } });
    if (!existing) return NextResponse.json(apiError("item_not_found", "This priority no longer exists."), { status: 404 });

    try {
      await requireDepartmentPermission(existing.departmentId, "priority.edit");
    } catch (error: any) {
      if (error.message === "Unauthorized") return unauthorizedResponse();
      return forbiddenResponse("You do not have permission to edit priorities in this department.");
    }

    const parsed = updatePrioritySchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    const priority = await prisma.ticketPriority.update({ where: { id }, data: parsed.data });
    await logDepartmentConfigHealth(prisma, existing.departmentId, "priorities PATCH");
    return NextResponse.json(priority);
  } catch (error: any) {
    if (error.code === "P2002") {
      return NextResponse.json(apiError("duplicate_priority_name", "A priority with this name already exists in this department.", { field: "name" }), { status: 409 });
    }
    return internalErrorResponse();
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json(apiError("invalid_payload", "A priority id is required."), { status: 400 });

    const existing = await prisma.ticketPriority.findUnique({
      where: { id },
      include: { _count: { select: { tickets: true } } },
    });
    if (!existing) return NextResponse.json(apiError("item_not_found", "This priority no longer exists."), { status: 404 });

    try {
      await requireDepartmentPermission(existing.departmentId, "priority.delete");
    } catch (error: any) {
      if (error.message === "Unauthorized") return unauthorizedResponse();
      return forbiddenResponse("You do not have permission to delete priorities in this department.");
    }

    if (existing._count.tickets > 0) {
      return NextResponse.json(
        apiError("item_in_use", `This priority is used by ${existing._count.tickets} ticket(s) and cannot be deleted. Deactivate it instead.`),
        { status: 409 }
      );
    }

    // SlaPolicy.priorityId has onDelete: Cascade, so an unused priority's
    // SLA override (if any) is removed automatically and atomically here —
    // no separate step needed, and never an orphaned SlaPolicy row.
    await prisma.ticketPriority.delete({ where: { id } });
    await logDepartmentConfigHealth(prisma, existing.departmentId, "priorities DELETE");
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.code === "P2003") {
      return NextResponse.json(apiError("item_in_use", "This priority is still referenced and cannot be deleted. Deactivate it instead."), { status: 409 });
    }
    return internalErrorResponse();
  }
}
