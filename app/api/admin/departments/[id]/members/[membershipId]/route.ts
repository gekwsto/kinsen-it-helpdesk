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

    // The active primary membership is User.departmentId's mirror source —
    // revoking it here (a "remove this member" action) would silently leave
    // User.departmentId pointing at a now-inactive membership, breaking the
    // canonical-membership invariant. Changing the primary department is a
    // deliberate action (Edit User's Primary Department field, which goes
    // through setPrimaryDepartmentMembership), never an implicit side effect
    // of removing a row from this list.
    if (membership.isPrimary && membership.isActive) {
      return NextResponse.json(
        {
          error: "This is the user's primary department and can't be removed from here. Change their Primary Department in Edit User first.",
          code: "cannot_remove_primary_membership",
        },
        { status: 409 }
      );
    }

    await revokeMembership(membershipId);
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
