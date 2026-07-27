import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireAnyDepartmentPermission } from "@/lib/permissions";
import { createCategorySchema, updateCategorySchema } from "@/lib/validations";
import { buildCategoryWhere } from "@/lib/services/department-scope-service";
import { apiError, zodErrorResponse, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

// Categories were originally gated only by the blanket department.manageSettings
// key; category.manage is additive on top of it (never a replacement) so an
// existing role that already had department.manageSettings doesn't lose
// category management the moment this ships — see prisma/seed.ts's
// TICKET_CONFIG_PERMISSION_KEYS comment.
const CATEGORY_PERMISSION_KEYS = ["category.manage", "department.manageSettings"];
// Delete additionally accepts the granular category.delete key, so a role
// can be granted delete-only capability without also holding category.manage.
const CATEGORY_DELETE_PERMISSION_KEYS = ["category.delete", ...CATEGORY_PERMISSION_KEYS];

// GET /api/admin/categories            -> every category (System Admin only, unchanged global view)
// GET /api/admin/categories?departmentId=X -> that department's own categories —
//   System Admin or a Department Admin of X.
export async function GET(req: NextRequest) {
  try {
    const departmentId = req.nextUrl.searchParams.get("departmentId");

    if (departmentId) {
      await requireAnyDepartmentPermission(departmentId, CATEGORY_PERMISSION_KEYS);
      const categories = await prisma.ticketCategory.findMany({
        where: buildCategoryWhere(departmentId),
        orderBy: { name: "asc" },
        include: { _count: { select: { tickets: true } }, department: { select: { id: true, name: true } } },
      });
      return NextResponse.json(categories);
    }

    await requireAdmin();
    const categories = await prisma.ticketCategory.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { tickets: true } }, department: { select: { id: true, name: true } } },
    });
    return NextResponse.json(categories);
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    return forbiddenResponse();
  }
}

export async function POST(req: NextRequest) {
  let attemptedName: string | undefined;
  try {
    const body = await req.json();
    const parsed = createCategorySchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);
    const { departmentId, ...data } = parsed.data;
    attemptedName = data.name;

    // Every category belongs to exactly one department now — there is no
    // more global/shared category. requireAnyDepartmentPermission already
    // bypasses for System Admin, so this covers both "admin creating for
    // any department" and "department admin creating for their own" in one call.
    if (!departmentId) {
      return NextResponse.json(apiError("department_required", "A department is required.", { field: "departmentId" }), { status: 400 });
    }

    try {
      await requireAnyDepartmentPermission(departmentId, CATEGORY_PERMISSION_KEYS);
    } catch (error: any) {
      if (error.message === "Unauthorized") return unauthorizedResponse();
      return forbiddenResponse("You do not have permission to create categories in this department.");
    }

    const department = await prisma.department.findUnique({ where: { id: departmentId }, select: { id: true } });
    if (!department) {
      return NextResponse.json(apiError("invalid_department", "The selected department does not exist.", { field: "departmentId" }), { status: 400 });
    }

    const category = await prisma.ticketCategory.create({ data: { ...data, departmentId } });
    return NextResponse.json(category, { status: 201 });
  } catch (error: any) {
    if (error.code === "P2002") {
      const name = attemptedName ? `"${attemptedName}"` : "This name";
      return NextResponse.json(apiError("duplicate_category_name", `${name} already exists as a category in this department.`, { field: "name" }), { status: 409 });
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
    // departmentId is deliberately never accepted here — moving a category
    // between departments isn't supported by this endpoint, only editing
    // name/description/color/isActive of an existing one.
    const { id, departmentId: _ignored, ...body } = raw;
    if (!id) return NextResponse.json(apiError("invalid_payload", "A category id is required."), { status: 400 });

    const existing = await prisma.ticketCategory.findUnique({ where: { id }, select: { departmentId: true } });
    if (!existing) return NextResponse.json(apiError("item_not_found", "This category no longer exists."), { status: 404 });

    try {
      await requireAnyDepartmentPermission(existing.departmentId, CATEGORY_PERMISSION_KEYS);
    } catch (error: any) {
      if (error.message === "Unauthorized") return unauthorizedResponse();
      return forbiddenResponse("You do not have permission to edit categories in this department.");
    }

    const parsed = updateCategorySchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    const category = await prisma.ticketCategory.update({ where: { id }, data: parsed.data });
    return NextResponse.json(category);
  } catch (error: any) {
    if (error.code === "P2002") {
      return NextResponse.json(apiError("duplicate_category_name", "A category with this name already exists in this department.", { field: "name" }), { status: 409 });
    }
    return internalErrorResponse();
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json(apiError("invalid_payload", "A category id is required."), { status: 400 });

    const existing = await prisma.ticketCategory.findUnique({
      where: { id },
      include: { _count: { select: { tickets: true } } },
    });
    if (!existing) return NextResponse.json(apiError("item_not_found", "This category no longer exists."), { status: 404 });

    try {
      await requireAnyDepartmentPermission(existing.departmentId, CATEGORY_DELETE_PERMISSION_KEYS);
    } catch (error: any) {
      if (error.message === "Unauthorized") return unauthorizedResponse();
      return forbiddenResponse("You do not have permission to delete categories in this department.");
    }

    if (existing._count.tickets > 0) {
      return NextResponse.json(
        apiError("item_in_use", `This category is used by ${existing._count.tickets} ticket(s) and cannot be deleted. Deactivate it instead.`),
        { status: 409 }
      );
    }

    await prisma.ticketCategory.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.code === "P2003") {
      return NextResponse.json(apiError("item_in_use", "This category is still referenced and cannot be deleted. Deactivate it instead."), { status: 409 });
    }
    return internalErrorResponse();
  }
}
