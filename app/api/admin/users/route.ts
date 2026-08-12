import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireAuth, hasPermission, canAssignUserToDepartment } from "@/lib/permissions";
import { createUserSchema } from "@/lib/validations";
import { translateGlobalRoleToDepartmentRole } from "@/lib/services/department-role-translation";
import { setPrimaryDepartmentMembership, grantManualMembership, DepartmentRoleAssignmentError } from "@/lib/services/department-membership-service";
import { assertGlobalRoleAssignable, GlobalRoleAssignmentError, type GlobalRoleSelection } from "@/lib/services/global-role-assignment-service";
import bcrypt from "bcryptjs";
import { AuthProvider, MembershipSource } from "@prisma/client";

const USER_INCLUDE = {
  department: { select: { id: true, name: true } },
  businessUnit: { select: { id: true, name: true } },
  customRole: { select: { id: true, key: true, name: true, isActive: true, isBuiltIn: true } },
  departmentMemberships: {
    include: {
      department: { select: { id: true, name: true, slug: true } },
      customRole: { select: { id: true, name: true, isActive: true } },
    },
    orderBy: { createdAt: "asc" as const },
  },
  subDepartmentMemberships: {
    where: { isActive: true },
    include: { subDepartment: { select: { id: true, name: true, departmentId: true } } },
    orderBy: { createdAt: "asc" as const },
  },
} as const;

export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(req.url);
    const search = searchParams.get("search") ?? "";

    const where: any = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ];
    }

    const users = await prisma.user.findMany({
      where,
      orderBy: { name: "asc" },
      include: {
        department: { select: { id: true, name: true } },
        businessUnit: { select: { id: true, name: true } },
        customRole: { select: { id: true, key: true, name: true, isActive: true, isBuiltIn: true } },
        departmentMemberships: {
          include: {
            department: { select: { id: true, name: true, slug: true } },
            customRole: { select: { id: true, name: true, isActive: true } },
          },
          orderBy: { createdAt: "asc" },
        },
        globalRoleMicrosoftMapping: {
          select: { microsoftValue: true, department: { select: { name: true } } },
        },
      },
    });

    return NextResponse.json(users);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();

    // Creating a brand-new account (name/email/password/role/isActive) is
    // always an account-management operation — department.user.assign alone
    // can't create accounts, only assign an EXISTING user to a department
    // (see PATCH /api/admin/users/[id]), so this stays strictly user.manage.
    const canManageUsers = await hasPermission(session.user.role, "user.manage", session.user.customRoleId);
    if (!canManageUsers) {
      return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    }

    const body = await req.json();
    const data = createUserSchema.parse(body);

    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) {
      return NextResponse.json({ error: "Email already in use" }, { status: 409 });
    }

    // Never trust the submitted role/customRoleId at face value — see
    // lib/services/global-role-assignment-service.ts's doc comment (ghost
    // DIRECTOR scenario). A brand-new user has no "current" role to compare
    // against, so this always validates against the live catalogue.
    const globalRoleSelection: GlobalRoleSelection = data.customRoleId
      ? { customRoleId: data.customRoleId }
      : { role: data.role };
    await assertGlobalRoleAssignable(globalRoleSelection, null, prisma);

    // ── Validate every department-membership row up front — nothing is
    // written until every row (and the resolved primary) is known-good, so
    // a rejected request never leaves a partially-created user behind. ──
    const rows = data.departmentMemberships;

    const seenDeptIds = new Set<string>();
    for (const row of rows) {
      if (seenDeptIds.has(row.departmentId)) {
        return NextResponse.json(
          { error: "The same department was selected more than once.", code: "duplicate_department" },
          { status: 400 }
        );
      }
      seenDeptIds.add(row.departmentId);
    }

    // Resolve the primary department: explicit primaryDepartmentId wins
    // (falling back to the legacy departmentId field for older callers),
    // else the first membership row, else none.
    const explicitPrimary = data.primaryDepartmentId !== undefined ? data.primaryDepartmentId : (data.departmentId || null);
    const resolvedPrimaryId = explicitPrimary !== null ? explicitPrimary : (rows[0]?.departmentId ?? null);

    // Every distinct department that needs validating — the membership rows
    // plus a primary that wasn't already one of them (the legacy
    // "just a primary department, no membership rows" case).
    const allDeptIdsToValidate = new Set(seenDeptIds);
    if (resolvedPrimaryId) allDeptIdsToValidate.add(resolvedPrimaryId);

    if (allDeptIdsToValidate.size > 0) {
      const foundDepartments = await prisma.department.findMany({
        where: { id: { in: [...allDeptIdsToValidate] } },
        select: { id: true },
      });
      const foundIds = new Set(foundDepartments.map((d) => d.id));
      const missing = [...allDeptIdsToValidate].find((id) => !foundIds.has(id));
      if (missing) {
        return NextResponse.json({ error: "Department not found", code: "invalid_department" }, { status: 400 });
      }
    }

    // Custom department-role validation: the CustomRole must exist and be
    // DEPARTMENT/BOTH scope — a GLOBAL custom role can never back a
    // DepartmentMembership (mirrors the same check on the department
    // members POST route).
    const customRoleIds = rows.map((r) => r.customRoleId).filter((id): id is string => !!id);
    if (customRoleIds.length > 0) {
      const foundCustomRoles = await prisma.customRole.findMany({
        where: { id: { in: customRoleIds } },
        select: { id: true, scope: true },
      });
      const foundById = new Map(foundCustomRoles.map((r) => [r.id, r]));
      for (const cid of customRoleIds) {
        const found = foundById.get(cid);
        if (!found || found.scope === "GLOBAL") {
          return NextResponse.json({ error: "Invalid department role.", code: "invalid_role" }, { status: 400 });
        }
      }
    }

    // Permission check per row — a caller without blanket user.manage must
    // independently hold department.user.assign in EVERY department they're
    // trying to assign this new user into.
    if (!canManageUsers) {
      for (const deptId of allDeptIdsToValidate) {
        const allowed = await canAssignUserToDepartment(session.user.role, session.user.customRoleId, session.user.id, deptId);
        if (!allowed) {
          return NextResponse.json(
            { error: "You don't have access to assign users to one of the selected departments", code: "missing_permission", departmentId: deptId },
            { status: 403 }
          );
        }
      }
    }

    const passwordHash = await bcrypt.hash(data.password, 12);

    const created = await prisma.$transaction(async (tx) => {
      // departmentId is deliberately NOT set here — User.departmentId is a
      // mirror of the active primary DepartmentMembership, written only by
      // setPrimaryDepartmentMembership below, never independently here (see
      // the User/Department/Member canonical-membership architecture).
      const newUser = await tx.user.create({
        data: {
          name: data.name,
          email: data.email,
          passwordHash,
          role: data.role,
          customRoleId: data.customRoleId ?? null,
          isActive: data.isActive,
          businessUnitId: data.businessUnitId || null,
          authProvider: AuthProvider.CREDENTIALS,
          mustChangePassword: true,
        },
      });

      for (const row of rows) {
        await grantManualMembership(
          newUser.id,
          row.departmentId,
          row.customRoleId ? { customRoleId: row.customRoleId } : { role: row.role! },
          tx
        );
      }

      return newUser;
    });

    // The primary department is a UI convenience over the real source of
    // truth (DepartmentMembership) — setPrimaryDepartmentMembership is the
    // single atomic write path for it, always called when a primary was
    // resolved (whether or not that department was ALSO one of the explicit
    // membership rows above — it's idempotent-safe either way: reuses the
    // row grantManualMembership may have just created, or creates a fresh
    // one, then marks it primary and mirrors User.departmentId in one
    // transaction). A bounded transaction of its own, run after the outer
    // one commits — matches this app's established "never one giant shared
    // transaction across a multi-step write" rule.
    if (resolvedPrimaryId) {
      const desiredRole = translateGlobalRoleToDepartmentRole(data.role);
      await setPrimaryDepartmentMembership(created.id, resolvedPrimaryId, MembershipSource.MANUAL, { role: desiredRole });
    }

    const user = await prisma.user.findUnique({ where: { id: created.id }, include: USER_INCLUDE });

    return NextResponse.json(user, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    if (error instanceof DepartmentRoleAssignmentError) {
      if (error.code === "ROLE_INACTIVE") {
        return NextResponse.json({ error: "One of the selected department roles is disabled and cannot be assigned.", code: "role_inactive" }, { status: 409 });
      }
      return NextResponse.json({ error: "Invalid department role.", code: "invalid_role" }, { status: 400 });
    }
    if (error instanceof GlobalRoleAssignmentError) {
      if (error.code === "ROLE_INACTIVE") {
        return NextResponse.json({ error: "The selected global role is disabled and cannot be assigned.", code: "role_inactive" }, { status: 409 });
      }
      return NextResponse.json({ error: "Invalid global role.", code: "invalid_role" }, { status: 400 });
    }
    if (error.message === "Forbidden" || error.message === "Unauthorized") {
      return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
