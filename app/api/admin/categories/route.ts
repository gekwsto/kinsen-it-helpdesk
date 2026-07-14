import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireDepartmentPermission } from "@/lib/permissions";
import { createCategorySchema } from "@/lib/validations";

// GET /api/admin/categories            -> every category (System Admin only, unchanged global view)
// GET /api/admin/categories?departmentId=X -> that department's own categories
//   (+ global ones, since they're relevant everywhere) — System Admin or a
//   Department Admin of X.
export async function GET(req: NextRequest) {
  try {
    const departmentId = req.nextUrl.searchParams.get("departmentId");

    if (departmentId) {
      await requireDepartmentPermission(departmentId, "department.manageSettings");
      const categories = await prisma.ticketCategory.findMany({
        where: { OR: [{ departmentId: null }, { departmentId }] },
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
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const data = createCategorySchema.parse(body);

    if (data.departmentId) {
      await requireDepartmentPermission(data.departmentId, "department.manageSettings");
    } else {
      // Global category (departmentId omitted/null) — System Admin only.
      await requireAdmin();
      // The DB's @@unique([departmentId, name]) can't catch this case:
      // Postgres treats every NULL departmentId as distinct from every other
      // NULL, so two global categories named identically wouldn't collide
      // at the constraint level. Checked explicitly instead.
      const existingGlobal = await prisma.ticketCategory.findFirst({
        where: { departmentId: null, name: data.name },
        select: { id: true },
      });
      if (existingGlobal) {
        return NextResponse.json({ error: "A global category with this name already exists." }, { status: 409 });
      }
    }

    const category = await prisma.ticketCategory.create({ data });
    return NextResponse.json(category, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    if (error.code === "P2002") {
      return NextResponse.json({ error: "A category with this name already exists in this department." }, { status: 409 });
    }
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
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
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (existing.departmentId) {
      await requireDepartmentPermission(existing.departmentId, "department.manageSettings");
    } else {
      await requireAdmin();
    }

    const category = await prisma.ticketCategory.update({ where: { id }, data });
    return NextResponse.json(category);
  } catch (error: any) {
    if (error.code === "P2002") {
      return NextResponse.json({ error: "A category with this name already exists in this department." }, { status: 409 });
    }
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 });

    const existing = await prisma.ticketCategory.findUnique({ where: { id }, select: { departmentId: true } });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (existing.departmentId) {
      await requireDepartmentPermission(existing.departmentId, "department.manageSettings");
    } else {
      await requireAdmin();
    }

    await prisma.ticketCategory.update({
      where: { id },
      data: { isActive: false },
    });
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
