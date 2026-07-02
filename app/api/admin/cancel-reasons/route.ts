import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/permissions";
import { z } from "zod";

const createSchema = z.object({
  name: z.string().min(1).max(100).transform((s) => s.trim()),
  description: z.string().max(500).optional().transform((s) => s?.trim() || undefined),
});

const updateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(100).transform((s) => s.trim()).optional(),
  description: z.string().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
});

export async function GET() {
  try {
    await requireAdmin();
    const reasons = await prisma.ticketCancelReason.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { tickets: true } } },
    });
    return NextResponse.json(reasons);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
    const body = await req.json();
    const data = createSchema.parse(body);
    const reason = await prisma.ticketCancelReason.create({ data });
    return NextResponse.json(reason, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: "Name is required" }, { status: 422 });
    }
    if (error.code === "P2002") {
      return NextResponse.json({ error: "A cancel reason with this name already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    await requireAdmin();
    const body = await req.json();
    const { id, ...data } = updateSchema.parse(body);

    if (data.name) {
      const existing = await prisma.ticketCancelReason.findFirst({
        where: { name: data.name, NOT: { id } },
      });
      if (existing) {
        return NextResponse.json({ error: "A cancel reason with this name already exists" }, { status: 409 });
      }
    }

    const updated = await prisma.ticketCancelReason.update({ where: { id }, data });
    return NextResponse.json(updated);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: "Invalid data" }, { status: 422 });
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

    const reason = await prisma.ticketCancelReason.findUnique({
      where: { id },
      include: { _count: { select: { tickets: true } } },
    });
    if (!reason) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (reason._count.tickets > 0) {
      return NextResponse.json(
        { error: `This cancel reason is used by ${reason._count.tickets} ticket${reason._count.tickets > 1 ? "s" : ""} and cannot be deleted. Deactivate it instead.` },
        { status: 409 }
      );
    }

    await prisma.ticketCancelReason.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
