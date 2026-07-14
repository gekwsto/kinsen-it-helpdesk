import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
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

    const body = await req.json();
    const data = updateUserRoleSchema.parse(body);

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Admins may edit their own email/department/etc., but changing your own
    // role or active status could lock you out of the admin panel entirely.
    const isSelf = id === session.user.id;
    if (
      isSelf &&
      (data.role !== target.role || (data.isActive !== undefined && data.isActive !== target.isActive))
    ) {
      return NextResponse.json(
        { error: "You cannot change your own role or active status" },
        { status: 400 }
      );
    }

    if (data.email !== undefined) {
      const existing = await prisma.user.findFirst({
        where: { email: data.email, NOT: { id } },
        select: { id: true },
      });
      if (existing) {
        return NextResponse.json(
          { error: "A user with this email already exists." },
          { status: 409 }
        );
      }
    }

    const user = await prisma.user.update({
      where: { id },
      data: {
        role: data.role,
        isActive: data.isActive,
        departmentId: data.departmentId,
        businessUnitId: data.businessUnitId,
        customRoleId: data.customRoleId !== undefined ? data.customRoleId : undefined,
        email: data.email,
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
    // Race-condition fallback: two concurrent requests could both pass the
    // pre-check above before either write commits.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json(
        { error: "A user with this email already exists." },
        { status: 409 }
      );
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
