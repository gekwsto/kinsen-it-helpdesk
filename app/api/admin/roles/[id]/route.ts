import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/permissions";
import { z } from "zod";

const updateRoleSchema = z.object({
  name: z.string().min(2).max(50).optional(),
  description: z.string().nullable().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await requireAdmin();

    const role = await prisma.customRole.findUnique({ where: { id } });
    if (!role) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (role.scope === "DEPARTMENT") {
      return NextResponse.json(
        { error: "Department roles cannot be renamed — their name follows the real DepartmentRole value." },
        { status: 409 }
      );
    }

    const body = await req.json();
    const data = updateRoleSchema.parse(body);

    const updated = await prisma.customRole.update({
      where: { id },
      data: {
        name: data.name ?? undefined,
        description: data.description !== undefined ? data.description : undefined,
      },
    });

    return NextResponse.json(updated);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await requireAdmin();

    const role = await prisma.customRole.findUnique({ where: { id } });
    if (!role) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (role.isBuiltIn) {
      return NextResponse.json(
        { error: "Built-in roles cannot be deleted — they correspond to a real Role/DepartmentRole enum value still used elsewhere in the app." },
        { status: 409 }
      );
    }

    const usersWithRole = await prisma.user.count({ where: { customRoleId: id } });
    if (usersWithRole > 0) {
      return NextResponse.json(
        { error: `This role is assigned to ${usersWithRole} user${usersWithRole > 1 ? "s" : ""} and cannot be deleted. Reassign them first.` },
        { status: 409 }
      );
    }

    // Remove all permission assignments for this role before deleting
    await prisma.rolePermission.deleteMany({ where: { roleKey: role.key } });
    await prisma.customRole.delete({ where: { id } });

    return new NextResponse(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}
