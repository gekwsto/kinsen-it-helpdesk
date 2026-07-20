import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireDepartmentPermission } from "@/lib/permissions";
import { revokeMembership } from "@/lib/services/department-membership-service";

/** Soft-revoke — never deletes the row, so ticket/project history referencing the user is unaffected. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; membershipId: string }> }
) {
  try {
    const { id, membershipId } = await params;
    await requireDepartmentPermission(id, "department.user.unassign");

    const membership = await prisma.departmentMembership.findUnique({ where: { id: membershipId } });
    if (!membership || membership.departmentId !== id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await revokeMembership(membershipId);
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
