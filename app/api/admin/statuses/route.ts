import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/permissions";
import { createStatusSchema } from "@/lib/validations";

export async function GET() {
  try {
    await requireAdmin();
    const statuses = await prisma.ticketStatus.findMany({
      orderBy: { order: "asc" },
      include: { _count: { select: { tickets: true } } },
    });
    return NextResponse.json(statuses);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
    const body = await req.json();
    const data = createStatusSchema.parse(body);
    const status = await prisma.ticketStatus.create({ data });
    return NextResponse.json(status, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    await requireAdmin();
    const body = await req.json();
    const { id, ...data } = body;
    const status = await prisma.ticketStatus.update({ where: { id }, data });
    return NextResponse.json(status);
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 });
    await prisma.ticketStatus.update({
      where: { id },
      data: { isActive: false },
    });
    return new NextResponse(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
