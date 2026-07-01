import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import { Role } from "@prisma/client";

export async function GET(req: NextRequest) {
  try {
    await requireAuth();
    const { searchParams } = new URL(req.url);
    const role = searchParams.get("role");

    const where: any = { isActive: true };
    if (role && Object.values(Role).includes(role as Role)) {
      where.role = role as Role;
    }

    const users = await prisma.user.findMany({
      where,
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, role: true, image: true },
    });

    return NextResponse.json(users);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
