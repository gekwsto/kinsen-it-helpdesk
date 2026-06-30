import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/permissions";

type RouteParams = { params: Promise<{ id: string; permId: string }> };

// POST — assign permission to role
export async function POST(_req: NextRequest, { params }: RouteParams) {
  try {
    const { id, permId } = await params;
    await requireAdmin();

    const role = await prisma.customRole.findUnique({ where: { id } });
    if (!role) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const perm = await prisma.permission.findUnique({ where: { id: permId } });
    if (!perm) return NextResponse.json({ error: "Permission not found" }, { status: 404 });

    await prisma.rolePermission.upsert({
      where: { roleKey_permissionId: { roleKey: role.key, permissionId: permId } },
      update: {},
      create: { roleKey: role.key, permissionId: permId },
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}

// DELETE — remove permission from role
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  try {
    const { id, permId } = await params;
    await requireAdmin();

    const role = await prisma.customRole.findUnique({ where: { id } });
    if (!role) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await prisma.rolePermission.deleteMany({
      where: { roleKey: role.key, permissionId: permId },
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}
