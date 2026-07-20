import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireDepartmentPermission } from "@/lib/permissions";
import { createSubDepartmentSchema } from "@/lib/validations";
import { listSubDepartments, createSubDepartment } from "@/lib/services/sub-department-service";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await requireDepartmentPermission(id, "subdepartment.view");

    const subDepartments = await listSubDepartments(id, { includeInactive: true });
    return NextResponse.json(subDepartments);
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await requireDepartmentPermission(id, "subdepartment.create");

    const department = await prisma.department.findUnique({ where: { id }, select: { isActive: true } });
    if (!department) return NextResponse.json({ error: "Not found", code: "invalid_department" }, { status: 404 });
    if (!department.isActive) {
      return NextResponse.json(
        { error: "Cannot create sub-departments under an inactive department.", code: "invalid_department" },
        { status: 409 }
      );
    }

    const body = await req.json();
    const data = createSubDepartmentSchema.parse(body);

    const existing = await prisma.subDepartment.findFirst({ where: { departmentId: id, name: data.name } });
    if (existing) {
      return NextResponse.json(
        { error: "A sub-department with this name already exists in this department.", code: "invalid_subdepartment" },
        { status: 409 }
      );
    }

    const subDepartment = await createSubDepartment({ departmentId: id, name: data.name, description: data.description });
    return NextResponse.json(subDepartment, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
