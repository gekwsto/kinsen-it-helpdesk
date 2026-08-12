import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireDepartmentPermission } from "@/lib/permissions";
import { grantMembershipSchema } from "@/lib/validations";
import {
  getDepartmentMemberships,
  grantManualMembership,
  DepartmentRoleAssignmentError,
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

    // Role eligibility (exists, correct scope, active for a genuinely new
    // assignment) is validated once, centrally, inside grantManualMembership
    // — never re-checked here, so there is exactly one place that decides
    // whether a role selection is assignable.
    const membership = data.customRoleId
      ? await grantManualMembership(data.userId, id, { customRoleId: data.customRoleId })
      : await grantManualMembership(data.userId, id, { role: data.role! });
    return NextResponse.json(membership, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    if (error instanceof DepartmentRoleAssignmentError) {
      if (error.code === "ROLE_NOT_FOUND") {
        return NextResponse.json({ error: "Role not found.", code: "invalid_department" }, { status: 400 });
      }
      if (error.code === "ROLE_WRONG_SCOPE") {
        return NextResponse.json({ error: "This role cannot be assigned to a Department Membership.", code: "invalid_department" }, { status: 400 });
      }
      if (error.code === "ROLE_INACTIVE") {
        return NextResponse.json({ error: "This role is disabled and cannot be assigned to new memberships.", code: "role_inactive" }, { status: 409 });
      }
    }
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
