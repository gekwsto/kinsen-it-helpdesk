/**
 * POST /api/admin/users: Add User now supports multiple Department
 * Memberships (with per-department roles) in one transactional request,
 * not just one legacy "Primary Department" field. This mirrors the route's
 * exact algorithm (lib/services/department-membership-service.ts's
 * grantManualMembership inside a prisma.$transaction, validation entirely
 * BEFORE the transaction starts) rather than calling the Next.js handler
 * directly, matching every other test script in this codebase.
 *
 * Tests:
 *  1. Create with zero departments: User.departmentId null, no memberships.
 *  2. Create with one department + role: departmentId set, one active MANUAL membership with the given role.
 *  3. Create with multiple departments + different roles: both memberships created correctly.
 *  4. Primary defaults to the first row when primaryDepartmentId isn't explicit.
 *  5. An explicit primaryDepartmentId (different from the first row) is honored.
 *  6. Duplicate departmentId across rows is rejected before any write — no user created.
 *  7. A department.user.assign-only caller (no user.manage) is denied for a department they don't manage.
 *  8. "Rollback" semantics: an early validation failure (invalid department) leaves no user row behind.
 *
 * Usage: npx tsx scripts/test-add-user-multi-department.ts
 * Requires a reachable DATABASE_URL AND the
 * 20260721100000_add_subdepartments_and_custom_department_roles migration
 * applied (DepartmentMembership.customRoleId) — reports clearly and exits if
 * either is missing.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";
import { grantManualMembership } from "@/lib/services/department-membership-service";
import { canAssignUserToDepartment } from "@/lib/permissions";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const RUN_ID = Date.now();

/** Mirrors POST /api/admin/users's row-creation algorithm exactly. */
async function createUserWithMemberships(input: {
  email: string;
  role: Role;
  primaryDepartmentId?: string | null;
  rows: Array<{ departmentId: string; role: DepartmentRole }>;
}) {
  const seenDeptIds = new Set<string>();
  for (const row of input.rows) {
    if (seenDeptIds.has(row.departmentId)) {
      return { ok: false as const, code: "duplicate_department" };
    }
    seenDeptIds.add(row.departmentId);
  }

  const explicitPrimary = input.primaryDepartmentId !== undefined ? input.primaryDepartmentId : null;
  const resolvedPrimaryId = explicitPrimary !== null ? explicitPrimary : (input.rows[0]?.departmentId ?? null);

  const allDeptIds = new Set(seenDeptIds);
  if (resolvedPrimaryId) allDeptIds.add(resolvedPrimaryId);

  if (allDeptIds.size > 0) {
    const found = await prisma.department.findMany({ where: { id: { in: [...allDeptIds] } }, select: { id: true } });
    const foundIds = new Set(found.map((d) => d.id));
    const missing = [...allDeptIds].find((id) => !foundIds.has(id));
    if (missing) return { ok: false as const, code: "invalid_department" };
  }

  const user = await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: {
        email: input.email,
        authProvider: AuthProvider.CREDENTIALS,
        role: input.role,
        departmentId: resolvedPrimaryId,
      },
    });
    for (const row of input.rows) {
      await grantManualMembership(newUser.id, row.departmentId, { role: row.role }, tx);
    }
    return newUser;
  });

  return { ok: true as const, user, resolvedPrimaryId };
}

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  let migrationApplied = true;
  try {
    await prisma.departmentMembership.findFirst({ select: { id: true, customRoleId: true } });
  } catch (err) {
    migrationApplied = false;
    console.log(
      "\nDepartmentMembership.customRoleId isn't usable against this database yet (migration " +
        "20260721100000_add_subdepartments_and_custom_department_roles not applied) — skipping."
    );
    console.log(String(err instanceof Error ? err.message : err));
  }
  if (!migrationApplied) {
    printSummaryAndExit();
    return;
  }

  let deptA: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let deptB: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let managerUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const createdUserIds: string[] = [];
  const membershipIds: string[] = [];

  try {
    deptA = await prisma.department.create({ data: { name: `Test Multi Dept A ${RUN_ID}`, slug: `test-multi-dept-a-${RUN_ID}` } });
    deptB = await prisma.department.create({ data: { name: `Test Multi Dept B ${RUN_ID}`, slug: `test-multi-dept-b-${RUN_ID}` } });

    console.log("\nTesting create with zero departments...\n");
    const r1 = await createUserWithMemberships({ email: `test-multi-1-${RUN_ID}@kinsen.gr`, role: Role.USER, rows: [] });
    check("Succeeded", r1.ok);
    if (r1.ok) {
      createdUserIds.push(r1.user.id);
      check("User.departmentId is null", r1.user.departmentId === null);
      const count = await prisma.departmentMembership.count({ where: { userId: r1.user.id } });
      check("No membership created", count === 0);
    }

    console.log("\nTesting create with one department + role...\n");
    const r2 = await createUserWithMemberships({
      email: `test-multi-2-${RUN_ID}@kinsen.gr`,
      role: Role.IT_AGENT,
      rows: [{ departmentId: deptA.id, role: DepartmentRole.AGENT_ASSIGNEE }],
    });
    check("Succeeded", r2.ok);
    if (r2.ok) {
      createdUserIds.push(r2.user.id);
      check("User.departmentId set to deptA (defaulted to first row)", r2.user.departmentId === deptA.id);
      const m = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: r2.user.id, departmentId: deptA.id } } });
      if (m) membershipIds.push(m.id);
      check("Membership active", m?.isActive === true);
      check("Membership source MANUAL", m?.source === MembershipSource.MANUAL);
      check("Membership role AGENT_ASSIGNEE", m?.role === DepartmentRole.AGENT_ASSIGNEE);
    }

    console.log("\nTesting create with multiple departments + different roles...\n");
    const r3 = await createUserWithMemberships({
      email: `test-multi-3-${RUN_ID}@kinsen.gr`,
      role: Role.USER,
      rows: [
        { departmentId: deptA.id, role: DepartmentRole.AGENT_ASSIGNEE },
        { departmentId: deptB.id, role: DepartmentRole.VIEWER },
      ],
    });
    check("Succeeded", r3.ok);
    if (r3.ok) {
      createdUserIds.push(r3.user.id);
      const [mA, mB] = await Promise.all([
        prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: r3.user.id, departmentId: deptA.id } } }),
        prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: r3.user.id, departmentId: deptB.id } } }),
      ]);
      if (mA) membershipIds.push(mA.id);
      if (mB) membershipIds.push(mB.id);
      check("deptA membership role AGENT_ASSIGNEE", mA?.role === DepartmentRole.AGENT_ASSIGNEE);
      check("deptB membership role VIEWER", mB?.role === DepartmentRole.VIEWER);
      check("Primary defaulted to the first row (deptA)", r3.user.departmentId === deptA.id);
    }

    console.log("\nTesting an explicit primaryDepartmentId different from the first row...\n");
    const r4 = await createUserWithMemberships({
      email: `test-multi-4-${RUN_ID}@kinsen.gr`,
      role: Role.USER,
      primaryDepartmentId: deptB.id,
      rows: [
        { departmentId: deptA.id, role: DepartmentRole.VIEWER },
        { departmentId: deptB.id, role: DepartmentRole.AGENT_ASSIGNEE },
      ],
    });
    check("Succeeded", r4.ok);
    if (r4.ok) {
      createdUserIds.push(r4.user.id);
      check("Explicit primary (deptB) honored, not the first row (deptA)", r4.user.departmentId === deptB.id);
      const [mA, mB] = await Promise.all([
        prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: r4.user.id, departmentId: deptA.id } } }),
        prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: r4.user.id, departmentId: deptB.id } } }),
      ]);
      if (mA) membershipIds.push(mA.id);
      if (mB) membershipIds.push(mB.id);
      check("Both memberships still created despite explicit primary", mA !== null && mB !== null);
    }

    console.log("\nTesting duplicate department rejection (no user created)...\n");
    const dupEmail = `test-multi-dup-${RUN_ID}@kinsen.gr`;
    const r5 = await createUserWithMemberships({
      email: dupEmail,
      role: Role.USER,
      rows: [
        { departmentId: deptA.id, role: DepartmentRole.VIEWER },
        { departmentId: deptA.id, role: DepartmentRole.AGENT_ASSIGNEE },
      ],
    });
    check("Rejected with duplicate_department", !r5.ok && r5.code === "duplicate_department");
    const dupUserExists = await prisma.user.findUnique({ where: { email: dupEmail } });
    check("No user row was created for the rejected request", dupUserExists === null);

    console.log("\nTesting invalid-department rejection (rollback semantics — no user created)...\n");
    const invalidEmail = `test-multi-invalid-${RUN_ID}@kinsen.gr`;
    const r6 = await createUserWithMemberships({
      email: invalidEmail,
      role: Role.USER,
      rows: [{ departmentId: "nonexistent-department-id", role: DepartmentRole.VIEWER }],
    });
    check("Rejected with invalid_department", !r6.ok && r6.code === "invalid_department");
    const invalidUserExists = await prisma.user.findUnique({ where: { email: invalidEmail } });
    check("No user row was created for the rejected request", invalidUserExists === null);

    console.log("\nTesting canAssignUserToDepartment permission gate for a department.user.assign-only caller...\n");
    managerUser = await prisma.user.create({ data: { email: `test-multi-manager-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    const managerMembership = await prisma.departmentMembership.create({
      data: { userId: managerUser.id, departmentId: deptA.id, role: DepartmentRole.DEPARTMENT_MANAGER, source: MembershipSource.MANUAL, isActive: true },
    });
    membershipIds.push(managerMembership.id);
    check("Allowed for deptA (has department.user.assign there)", await canAssignUserToDepartment(Role.USER, null, managerUser.id, deptA.id));
    check("Denied for deptB (no standing there)", !(await canAssignUserToDepartment(Role.USER, null, managerUser.id, deptB.id)));
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: [...createdUserIds, managerUser?.id].filter((id): id is string => !!id) } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: [deptA?.id, deptB?.id].filter((id): id is string => !!id) } } })],
    ];
    for (const [label, step] of cleanupSteps) {
      try {
        await step();
      } catch (err) {
        console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
