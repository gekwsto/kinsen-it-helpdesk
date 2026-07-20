/**
 * Add/Edit User (app/api/admin/users/route.ts POST, [id]/route.ts PATCH):
 * selecting a Primary Department must also create/reactivate the real
 * DepartmentMembership, not just the legacy User.departmentId pointer.
 * Exercises the exact building blocks those routes call
 * (ensurePrimaryDepartmentMembership, translateGlobalRoleToDepartmentRole,
 * canAssignUserToDepartment) plus the same User.departmentId write, mirroring
 * route behavior end-to-end without spinning up an HTTP server (the
 * established pattern for every test script in this codebase).
 *
 * Tests:
 *  1. Create with a department: User.departmentId set, active membership
 *     created, source MANUAL, role translated from the global role.
 *  2. Create without a department: User.departmentId null, no membership.
 *  3. Edit department None -> IT: User.departmentId set, membership created.
 *  4. Edit department IT -> Sales: Sales membership created, IT membership untouched.
 *  5. Edit department -> None: User.departmentId cleared, no membership revoked.
 *  6. Inactive membership reactivated: no duplicate row, isActive true after.
 *  7. Existing active MICROSOFT_DEPARTMENT membership, same department, same
 *     translated role: source/role left untouched (not silently downgraded to MANUAL).
 *  7b. Same case, but the translated role actually differs: role updates AND
 *      source becomes MANUAL (mirrors the existing "manual override" rule).
 *  8. canAssignUserToDepartment: denied without department.user.assign or
 *     user.manage; allowed with either.
 *  9. Post-edit DB state reflects the new department without any manual
 *     department-page action (departmentMemberships include shows it).
 *
 * Usage: npx tsx scripts/test-user-department-membership-sync.ts
 * Requires a reachable DATABASE_URL AND the
 * 20260721100000_add_subdepartments_and_custom_department_roles migration
 * applied (DepartmentMembership.customRoleId) — reports clearly and exits if
 * either is missing.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";
import { ensurePrimaryDepartmentMembership } from "@/lib/services/department-membership-service";
import { translateGlobalRoleToDepartmentRole } from "@/lib/services/department-role-translation";
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

async function main() {
  console.log("Testing translateGlobalRoleToDepartmentRole (pure, no DB)...\n");
  check("USER -> REQUESTER", translateGlobalRoleToDepartmentRole(Role.USER) === DepartmentRole.REQUESTER);
  check("IT_AGENT -> AGENT_ASSIGNEE", translateGlobalRoleToDepartmentRole(Role.IT_AGENT) === DepartmentRole.AGENT_ASSIGNEE);
  check("DEPARTMENT_MANAGER -> DEPARTMENT_MANAGER", translateGlobalRoleToDepartmentRole(Role.DEPARTMENT_MANAGER) === DepartmentRole.DEPARTMENT_MANAGER);
  check("DIRECTOR -> VIEWER", translateGlobalRoleToDepartmentRole(Role.DIRECTOR) === DepartmentRole.VIEWER);
  check("ADMIN -> DEPARTMENT_ADMIN (never a system-wide grant — DepartmentRole has no ADMIN tier)", translateGlobalRoleToDepartmentRole(Role.ADMIN) === DepartmentRole.DEPARTMENT_ADMIN);

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("\nNo reachable DATABASE_URL in this environment — skipping DB-backed checks.");
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

  let deptIT: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let deptSales: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let managerUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let outsiderUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const createdUserIds: string[] = [];
  const membershipIds: string[] = [];

  try {
    deptIT = await prisma.department.create({ data: { name: `Test UserSync IT ${RUN_ID}`, slug: `test-usersync-it-${RUN_ID}` } });
    deptSales = await prisma.department.create({ data: { name: `Test UserSync Sales ${RUN_ID}`, slug: `test-usersync-sales-${RUN_ID}` } });

    // ── Test 1: create with a department ──────────────────────────────
    console.log("\nTesting Add User WITH a department...\n");
    const user1 = await prisma.user.create({
      data: { email: `test-usersync-1-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER, departmentId: deptIT.id },
    });
    createdUserIds.push(user1.id);
    const desiredRole1 = translateGlobalRoleToDepartmentRole(Role.USER);
    const membership1 = await ensurePrimaryDepartmentMembership(user1.id, deptIT.id, desiredRole1);
    membershipIds.push(membership1.id);

    check("User.departmentId set", (await prisma.user.findUnique({ where: { id: user1.id } }))?.departmentId === deptIT.id);
    check("Membership created active", membership1.isActive === true);
    check("Membership source is MANUAL", membership1.source === MembershipSource.MANUAL);
    check("Membership role translated from global role (USER -> REQUESTER)", membership1.role === DepartmentRole.REQUESTER);

    // ── Test 2: create without a department ───────────────────────────
    console.log("\nTesting Add User WITHOUT a department...\n");
    const user2 = await prisma.user.create({
      data: { email: `test-usersync-2-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER },
    });
    createdUserIds.push(user2.id);
    check("User.departmentId is null", user2.departmentId === null);
    const membershipsForUser2 = await prisma.departmentMembership.count({ where: { userId: user2.id } });
    check("No membership created", membershipsForUser2 === 0);

    // ── Test 3: edit department None -> IT ────────────────────────────
    console.log("\nTesting Edit User department None -> IT...\n");
    await prisma.user.update({ where: { id: user2.id }, data: { departmentId: deptIT.id } });
    const membership3 = await ensurePrimaryDepartmentMembership(user2.id, deptIT.id, translateGlobalRoleToDepartmentRole(Role.USER));
    membershipIds.push(membership3.id);
    check("User.departmentId set to IT", (await prisma.user.findUnique({ where: { id: user2.id } }))?.departmentId === deptIT.id);
    check("IT membership created active", membership3.isActive === true);

    // ── Test 4: edit department IT -> Sales, old membership untouched ─
    console.log("\nTesting Edit User department IT -> Sales (old membership preserved)...\n");
    await prisma.user.update({ where: { id: user2.id }, data: { departmentId: deptSales.id } });
    const membership4 = await ensurePrimaryDepartmentMembership(user2.id, deptSales.id, translateGlobalRoleToDepartmentRole(Role.USER));
    membershipIds.push(membership4.id);
    check("User.departmentId set to Sales", (await prisma.user.findUnique({ where: { id: user2.id } }))?.departmentId === deptSales.id);
    check("Sales membership created active", membership4.isActive === true);
    const itMembershipAfterMove = await prisma.departmentMembership.findUnique({
      where: { userId_departmentId: { userId: user2.id, departmentId: deptIT.id } },
    });
    check("IT membership still exists and still active (not revoked by the move)", itMembershipAfterMove !== null && itMembershipAfterMove.isActive === true);

    // ── Test 5: edit department -> None, memberships not revoked ──────
    console.log("\nTesting Edit User department -> None (no revoke)...\n");
    await prisma.user.update({ where: { id: user2.id }, data: { departmentId: null } });
    check("User.departmentId cleared", (await prisma.user.findUnique({ where: { id: user2.id } }))?.departmentId === null);
    const activeMembershipsAfterClear = await prisma.departmentMembership.count({ where: { userId: user2.id, isActive: true } });
    check("Existing memberships (IT + Sales) both still active — none revoked", activeMembershipsAfterClear === 2);

    // ── Test 6: inactive membership reactivated, no duplicate ─────────
    console.log("\nTesting inactive membership reactivation (no duplicate)...\n");
    await prisma.departmentMembership.update({ where: { id: membership1.id }, data: { isActive: false } });
    const reactivated = await ensurePrimaryDepartmentMembership(user1.id, deptIT.id, translateGlobalRoleToDepartmentRole(Role.USER));
    check("Reactivated row is the SAME row (no duplicate)", reactivated.id === membership1.id);
    check("isActive true after reactivation", reactivated.isActive === true);
    const countForUser1InIT = await prisma.departmentMembership.count({ where: { userId: user1.id, departmentId: deptIT.id } });
    check("Exactly one membership row for user1/deptIT", countForUser1InIT === 1);

    // ── Test 7: Microsoft-sourced membership, same dept, same role -> untouched ──
    console.log("\nTesting Microsoft-sourced membership preservation...\n");
    const msUser = await prisma.user.create({
      data: { email: `test-usersync-ms-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.MICROSOFT, role: Role.IT_AGENT, departmentId: deptIT.id },
    });
    createdUserIds.push(msUser.id);
    const msMembership = await prisma.departmentMembership.create({
      data: { userId: msUser.id, departmentId: deptIT.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MICROSOFT_DEPARTMENT, isActive: true },
    });
    membershipIds.push(msMembership.id);

    const untouched = await ensurePrimaryDepartmentMembership(msUser.id, deptIT.id, translateGlobalRoleToDepartmentRole(Role.IT_AGENT));
    check("Same translated role -> source stays MICROSOFT_DEPARTMENT (not silently downgraded)", untouched.source === MembershipSource.MICROSOFT_DEPARTMENT);
    check("updatedAt unchanged (truly a no-op, not just same source)", untouched.updatedAt.getTime() === msMembership.updatedAt.getTime());

    console.log("\nTesting Microsoft-sourced membership WITH an actual role change...\n");
    const roleChanged = await ensurePrimaryDepartmentMembership(msUser.id, deptIT.id, DepartmentRole.DEPARTMENT_MANAGER);
    check("Role updated to the new desired role", roleChanged.role === DepartmentRole.DEPARTMENT_MANAGER);
    check("Source becomes MANUAL once the role actually changes", roleChanged.source === MembershipSource.MANUAL);

    // ── Test 8: permission gate ────────────────────────────────────────
    console.log("\nTesting canAssignUserToDepartment...\n");
    managerUser = await prisma.user.create({ data: { email: `test-usersync-manager-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    outsiderUser = await prisma.user.create({ data: { email: `test-usersync-outsider-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    const managerMembership = await prisma.departmentMembership.create({
      data: { userId: managerUser.id, departmentId: deptIT.id, role: DepartmentRole.DEPARTMENT_MANAGER, source: MembershipSource.MANUAL, isActive: true },
    });
    membershipIds.push(managerMembership.id);

    check(
      "DEPARTMENT_MANAGER (has department.user.assign in deptIT) is allowed",
      await canAssignUserToDepartment(Role.USER, null, managerUser.id, deptIT.id)
    );
    check(
      "DEPARTMENT_MANAGER has NO standing in deptSales -> denied",
      !(await canAssignUserToDepartment(Role.USER, null, managerUser.id, deptSales.id))
    );
    check(
      "Outsider with no membership anywhere -> denied",
      !(await canAssignUserToDepartment(Role.USER, null, outsiderUser.id, deptIT.id))
    );
    check(
      "ADMIN (global role, via user.manage bypass) is always allowed",
      await canAssignUserToDepartment(Role.ADMIN, null, outsiderUser.id, deptIT.id)
    );

    // ── Test 9: post-edit DB state reflects the new department ────────
    console.log("\nTesting post-edit DB state (no manual department-page action needed)...\n");
    const finalUser = await prisma.user.findUnique({
      where: { id: user2.id },
      include: { departmentMemberships: { where: { isActive: true }, include: { department: { select: { name: true } } } } },
    });
    check(
      "user2's active memberships include Sales without any department-page action",
      finalUser?.departmentMemberships.some((m) => m.departmentId === deptSales!.id) === true
    );
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      [
        "users",
        () =>
          prisma.user.deleteMany({
            where: { id: { in: [...createdUserIds, managerUser?.id, outsiderUser?.id].filter((id): id is string => !!id) } },
          }),
      ],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: [deptIT?.id, deptSales?.id].filter((id): id is string => !!id) } } })],
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
