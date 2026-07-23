import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireAnyDepartmentPermission } from "@/lib/permissions";
import { createCategorySchema } from "@/lib/validations";
import { buildCategoryWhere } from "@/lib/services/department-scope-service";

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
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { departmentId, ...data } = createCategorySchema.parse(body);

    // Every category belongs to exactly one department now — there is no
    // more global/shared category. requireAnyDepartmentPermission already
    // bypasses for System Admin, so this covers both "admin creating for
    // any department" and "department admin creating for their own" in one call.
    if (!departmentId) {
      return NextResponse.json({ error: "A department is required.", code: "department_required" }, { status: 400 });
    }
    await requireAnyDepartmentPermission(departmentId, CATEGORY_PERMISSION_KEYS);

    const category = await prisma.ticketCategory.create({ data: { ...data, departmentId } });
    return NextResponse.json(category, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    if (error.code === "P2002") {
      return NextResponse.json({ error: "A category with this name already exists in this department.", code: "duplicate_name" }, { status: 409 });
    }
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    return NextResponse.json({ error: "Internal error", code: "internal_error" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    // departmentId is deliberately never accepted here — moving a category
    // between departments isn't supported by this endpoint, only editing
    // name/description/color/isActive of an existing one.
    const { id, departmentId: _ignored, ...data } = body;
    if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 });

    const existing = await prisma.ticketCategory.findUnique({ where: { id }, select: { departmentId: true } });
    if (!existing) return NextResponse.json({ error: "Not found", code: "item_not_found" }, { status: 404 });

    await requireAnyDepartmentPermission(existing.departmentId, CATEGORY_PERMISSION_KEYS);

    const category = await prisma.ticketCategory.update({ where: { id }, data });
    return NextResponse.json(category);
  } catch (error: any) {
    if (error.code === "P2002") {
      return NextResponse.json({ error: "A category with this name already exists in this department.", code: "duplicate_name" }, { status: 409 });
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

    const existing = await prisma.ticketCategory.findUnique({
      where: { id },
      include: { _count: { select: { tickets: true } } },
    });
    if (!existing) return NextResponse.json({ error: "Not found", code: "item_not_found" }, { status: 404 });

    await requireAnyDepartmentPermission(existing.departmentId, CATEGORY_DELETE_PERMISSION_KEYS);

    if (existing._count.tickets > 0) {
      return NextResponse.json(
        {
          error: `This category is used by ${existing._count.tickets} ticket(s) and cannot be deleted. Deactivate it instead.`,
          code: "item_in_use",
        },
        { status: 409 }
      );
    }

    await prisma.ticketCategory.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    if (error.code === "P2003") return NextResponse.json({ error: "This category is still referenced and cannot be deleted. Deactivate it instead.", code: "item_in_use" }, { status: 409 });
    return NextResponse.json({ error: "Internal error", code: "internal_error" }, { status: 500 });
  }
}
