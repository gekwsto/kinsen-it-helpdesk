import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/permissions";
import { createDepartmentSchema } from "@/lib/validations";

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
    const department = await prisma.department.create({
      data,
      include: { businessUnit: { select: { id: true, name: true } } },
    });
    return NextResponse.json(department, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 });
    await prisma.department.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
