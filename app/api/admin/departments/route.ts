import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/permissions";
import { createDepartmentSchema } from "@/lib/validations";
import { createDepartment } from "@/lib/services/department-service";

export async function GET() {
  try {
    await requireAdmin();
    const departments = await prisma.department.findMany({
      orderBy: { name: "asc" },
      include: {
        businessUnit: { select: { id: true, name: true } },
        _count: { select: { users: true, tickets: true } },
      },
    });
    return NextResponse.json(departments);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
    const body = await req.json();
    const data = createDepartmentSchema.parse(body);
    // Slug is auto-generated from name (collision-checked) — the request
    // shape is unchanged, this is purely an internal addition.
    const department = await createDepartment(data);
    const withRelations = await prisma.department.findUnique({
      where: { id: department.id },
      include: { businessUnit: { select: { id: true, name: true } } },
    });
    return NextResponse.json(withRelations, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

// DELETE moved to [id]/route.ts (Phase 3) — now guarded by a dependents
// check (users/memberships/tickets/projects/etc.) before allowing removal.
