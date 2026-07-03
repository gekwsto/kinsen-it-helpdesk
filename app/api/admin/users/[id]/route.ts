import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/permissions";
import { updateUserRoleSchema } from "@/lib/validations";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAdmin();

    if (id === session.user.id) {
      return NextResponse.json(
        { error: "You cannot modify your own account" },
        { status: 400 }
      );
    }

    const body = await req.json();
    const data = updateUserRoleSchema.parse(body);

    const user = await prisma.user.update({
      where: { id },
      data: {
        role: data.role,
        isActive: data.isActive,
        departmentId: data.departmentId,
        businessUnitId: data.businessUnitId,
        customRoleId: data.customRoleId !== undefined ? data.customRoleId : undefined,
      },
      include: {
        department: { select: { id: true, name: true } },
        businessUnit: { select: { id: true, name: true } },
        customRole: { select: { id: true, key: true, name: true } },
      },
    });

    return NextResponse.json(user);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    if (error.message === "Forbidden" || error.message === "Unauthorized") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAdmin();

    if (id === session.user.id) {
      return NextResponse.json({ error: "You cannot delete your own account" }, { status: 400 });
    }

    const ticketCount = await prisma.ticket.count({ where: { requesterId: id } });
    if (ticketCount > 0) {
      return NextResponse.json(
        { error: `This user has ${ticketCount} ticket(s). Deactivate them instead of deleting.` },
        { status: 409 }
      );
    }

    await prisma.user.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.message === "Forbidden" || error.message === "Unauthorized") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
