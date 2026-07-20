import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireAuth, hasPermission, canAssignUserToDepartment } from "@/lib/permissions";
import { updateUserRoleSchema } from "@/lib/validations";
import { translateGlobalRoleToDepartmentRole } from "@/lib/services/department-role-translation";
import { ensurePrimaryDepartmentMembership } from "@/lib/services/department-membership-service";

const USER_INCLUDE = {
  department: { select: { id: true, name: true } },
  businessUnit: { select: { id: true, name: true } },
  customRole: { select: { id: true, key: true, name: true } },
  departmentMemberships: {
    include: { department: { select: { id: true, name: true, slug: true } } },
    orderBy: { createdAt: "asc" as const },
  },
  subDepartmentMemberships: {
    where: { isActive: true },
    include: { subDepartment: { select: { id: true, name: true, departmentId: true } } },
    orderBy: { createdAt: "asc" as const },
  },
} as const;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();

    const body = await req.json();
    const data = updateUserRoleSchema.parse(body);
    // primaryDepartmentId is the field name the Add/Edit User UI now sends;
    // departmentId is kept only for backward compatibility with any other
    // caller. If primaryDepartmentId is explicitly present (including
    // null, to clear it), it wins over departmentId.
    const departmentId = data.primaryDepartmentId !== undefined ? data.primaryDepartmentId : data.departmentId;

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

    const canManageUsers = await hasPermission(session.user.role, "user.manage", session.user.customRoleId);

    // Account-level fields (role/status/email/custom global role) always
    // require user.manage — department.user.assign alone only covers the
    // department-assignment side effect below, never these.
    const touchesAccountFields =
      data.role !== target.role ||
      (data.isActive !== undefined && data.isActive !== target.isActive) ||
      (data.email !== undefined && data.email !== target.email) ||
      (data.customRoleId !== undefined && data.customRoleId !== target.customRoleId);
    if (touchesAccountFields && !canManageUsers) {
      return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    }

    // Primary Department is a UI convenience over the real source of truth
    // (DepartmentMembership) — setting/changing it to a real department must
    // also create/reactivate the matching membership (see ensurePrimaryDepartmentMembership),
    // never just the legacy User.departmentId pointer. Clearing it to null
    // never touches memberships (existing memberships are managed from the
    // Department Memberships section / department members page instead).
    const departmentSettingToValue =
      departmentId !== undefined && departmentId !== target.departmentId && departmentId !== null;
    const departmentClearing =
      departmentId !== undefined && departmentId !== target.departmentId && departmentId === null;

    if (departmentClearing && !canManageUsers) {
      return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    }

    if (departmentSettingToValue) {
      const department = await prisma.department.findUnique({ where: { id: departmentId! }, select: { id: true } });
      if (!department) {
        return NextResponse.json({ error: "Department not found", code: "invalid_department" }, { status: 400 });
      }
      if (!canManageUsers) {
        const allowed = await canAssignUserToDepartment(session.user.role, session.user.customRoleId, session.user.id, departmentId!);
        if (!allowed) {
          return NextResponse.json({ error: "You don't have access to assign users to this department", code: "missing_permission" }, { status: 403 });
        }
      }
    }

    // An actual role change from this dialog is a deliberate admin decision
    // — mark it as a manual override so the next Microsoft login sync
    // leaves it alone (rule: manual overrides are never overwritten by
    // sync). Resubmitting the same role unchanged (the form always sends
    // `role`) does NOT flip this — only a real change counts, so fixing an
    // unrelated field like email doesn't silently lock out Microsoft sync.
    const isRoleChange = data.role !== target.role;

    await prisma.user.update({
      where: { id },
      data: {
        role: data.role,
        isActive: data.isActive,
        departmentId,
        businessUnitId: data.businessUnitId,
        customRoleId: data.customRoleId !== undefined ? data.customRoleId : undefined,
        email: data.email,
        ...(isRoleChange
          ? { globalRoleSource: "MANUAL", globalRoleUpdatedAt: new Date(), globalRoleMicrosoftMappingId: null }
          : {}),
      },
    });

    if (departmentSettingToValue) {
      const desiredRole = translateGlobalRoleToDepartmentRole(data.role);
      await ensurePrimaryDepartmentMembership(id, departmentId!, desiredRole);
    }

    const user = await prisma.user.findUnique({ where: { id }, include: USER_INCLUDE });

    return NextResponse.json(user);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    if (error.message === "Forbidden" || error.message === "Unauthorized") {
      return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
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
