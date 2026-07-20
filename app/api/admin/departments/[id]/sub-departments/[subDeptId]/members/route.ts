import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireDepartmentPermission } from "@/lib/permissions";
import {
  getSubDepartmentMemberships,
  grantSubDepartmentMembership,
} from "@/lib/services/sub-department-membership-service";
import { z } from "zod";

const assignSchema = z.object({ userId: z.string().min(1, "User is required") });

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; subDeptId: string }> }
) {
  try {
    const { id, subDeptId } = await params;
    await requireDepartmentPermission(id, "subdepartment.view");

    const subDepartment = await prisma.subDepartment.findUnique({ where: { id: subDeptId }, select: { departmentId: true } });
    if (!subDepartment || subDepartment.departmentId !== id) {
      return NextResponse.json({ error: "Not found", code: "invalid_subdepartment" }, { status: 404 });
    }

    const memberships = await getSubDepartmentMemberships(subDeptId);
    return NextResponse.json(memberships);
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}

/**
 * Requires the target user to already be an ACTIVE member of the parent
 * Department (see grantSubDepartmentMembership's "prefer block for safety"
 * rule) — never silently creates the department membership on their behalf.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; subDeptId: string }> }
) {
  try {
    const { id, subDeptId } = await params;
    await requireDepartmentPermission(id, "subdepartment.user.assign");

    const subDepartment = await prisma.subDepartment.findUnique({ where: { id: subDeptId }, select: { departmentId: true } });
    if (!subDepartment || subDepartment.departmentId !== id) {
      return NextResponse.json({ error: "Not found", code: "invalid_subdepartment" }, { status: 404 });
    }

    const body = await req.json();
    const data = assignSchema.parse(body);

    const user = await prisma.user.findUnique({ where: { id: data.userId }, select: { id: true } });
    if (!user) return NextResponse.json({ error: "User not found", code: "user_not_found" }, { status: 404 });

    const result = await grantSubDepartmentMembership(data.userId, subDeptId);
    if (!result.ok) {
      const messages: Record<typeof result.reason, string> = {
        subdepartment_not_found: "Sub-department not found.",
        subdepartment_inactive: "Cannot assign users to a disabled sub-department.",
        user_not_in_department: "This user must be an active member of the parent department before joining this sub-department.",
      };
      const status = result.reason === "subdepartment_not_found" ? 404 : 400;
      return NextResponse.json(
        { error: messages[result.reason], code: result.reason === "user_not_in_department" ? "user_not_in_department" : "invalid_subdepartment" },
        { status }
      );
    }

    return NextResponse.json(result.membership, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
