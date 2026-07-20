import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import { Role } from "@prisma/client";
import { getAssignableUsersForEntity, type AssignableEntityType } from "@/lib/services/assignment-eligibility-service";

const ASSIGNABLE_ENTITY_TYPES: AssignableEntityType[] = ["ticket", "activity", "project"];

export async function GET(req: NextRequest) {
  try {
    await requireAuth();
    const { searchParams } = new URL(req.url);
    const assignableFor = searchParams.get("assignableFor");

    // Server-authorized eligible-assignee list — the caller never filters a
    // full user list client-side. Existing `?role=` behavior (below) is
    // unchanged for any other caller.
    if (assignableFor) {
      if (!ASSIGNABLE_ENTITY_TYPES.includes(assignableFor as AssignableEntityType)) {
        return NextResponse.json({ error: "Invalid assignableFor value" }, { status: 400 });
      }
      const departmentId = searchParams.get("departmentId");
      const users = await getAssignableUsersForEntity(assignableFor as AssignableEntityType, departmentId || null);
      return NextResponse.json(users);
    }

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
