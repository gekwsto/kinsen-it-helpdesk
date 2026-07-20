import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireDepartmentPermission } from "@/lib/permissions";
import { grantMembershipSchema } from "@/lib/validations";
import {
  getDepartmentMemberships,
  grantManualMembership,
} from "@/lib/services/department-membership-service";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await requireDepartmentPermission(id, "department.manageMembers");

    const memberships = await getDepartmentMemberships(id);
    return NextResponse.json(memberships);
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}

/**
 * Adds a member, changes an existing member's role, or reactivates a
 * revoked membership — all the same upsert (grantManualMembership already
 * covers all three; a "promotion" is an update, not a new row). Always
 * source: MANUAL, so it's protected from being overwritten by the next
 * Microsoft login sync.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await requireDepartmentPermission(id, "department.user.assign");

    const department = await prisma.department.findUnique({ where: { id }, select: { isActive: true } });
    if (!department) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (!department.isActive) {
      return NextResponse.json(
        { error: "Cannot assign members to an inactive department." },
        { status: 409 }
      );
    }

    const body = await req.json();
    const data = grantMembershipSchema.parse(body);

    const user = await prisma.user.findUnique({ where: { id: data.userId }, select: { id: true } });
    if (!user) return NextResponse.json({ error: "User not found", code: "user_not_found" }, { status: 404 });

    if (data.customRoleId) {
      // Never trust a client-submitted customRoleId at face value — must be
      // a real, non-GLOBAL role (a GLOBAL-scope custom role has no meaning
      // as a DepartmentMembership role).
      const customRole = await prisma.customRole.findUnique({ where: { id: data.customRoleId } });
      if (!customRole || customRole.scope === "GLOBAL") {
        return NextResponse.json({ error: "Invalid department role.", code: "invalid_department" }, { status: 400 });
      }
      const membership = await grantManualMembership(data.userId, id, { customRoleId: data.customRoleId });
      return NextResponse.json(membership, { status: 201 });
    }

    const membership = await grantManualMembership(data.userId, id, { role: data.role! });
    return NextResponse.json(membership, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
