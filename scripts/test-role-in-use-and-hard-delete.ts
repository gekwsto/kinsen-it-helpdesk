/**
 * DELETE /api/admin/roles/[id] keeps two of its checks exactly as before:
 * built-in roles are never hard-deleted (their key is load-bearing elsewhere
 * — see the route's comment), and an in-use custom role is blocked with
 * `role_in_use`. Only the reasoning/message changed (built-in now points at
 * Disable instead of asserting the role is frozen) — the actual gate
 * conditions (`role.isBuiltIn`, then the users/memberships count) are
 * untouched. This test mirrors those exact conditions.
 *
 * Tests:
 *  1. A built-in role (IT_AGENT) still reports isBuiltIn === true → hard
 *     delete stays blocked regardless of use.
 *  2. A custom role referenced by a User.customRoleId is blocked from hard
 *     delete (role_in_use condition true).
 *  3. A custom role referenced by a DepartmentMembership.customRoleId is
 *     blocked from hard delete (role_in_use condition true).
 *  4. A custom role with zero references is NOT blocked and hard-deletes
 *     successfully (regression, unchanged from before this phase).
 *
 * Usage: npx tsx scripts/test-role-in-use-and-hard-delete.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { Role, RoleScope, DepartmentRole } from "@prisma/client";

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

/** Mirrors DELETE /api/admin/roles/[id]'s exact in-use check. */
async function isInUse(roleId: string): Promise<boolean> {
  const [usersWithRole, membershipsWithRole] = await Promise.all([
    prisma.user.count({ where: { customRoleId: roleId } }),
    prisma.departmentMembership.count({ where: { customRoleId: roleId } }),
  ]);
  return usersWithRole + membershipsWithRole > 0;
}

const RUN_ID = Date.now();

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  let unusedRole: { id: string; key: string } | undefined;
  let userInUseRole: { id: string; key: string } | undefined;
  let membershipInUseRole: { id: string; key: string } | undefined;
  let testUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let testDepartmentMembership: Awaited<ReturnType<typeof prisma.departmentMembership.create>> | undefined;

  try {
    console.log("\nTesting built-in role hard-delete stays blocked regardless of use...\n");
    const itAgent = await prisma.customRole.findUnique({
      where: { key: "IT_AGENT" },
      select: { id: true, key: true, isBuiltIn: true },
    });
    check("IT_AGENT is built-in — DELETE route blocks it with builtin_role_locked", itAgent?.isBuiltIn === true);

    console.log("\nTesting a custom role referenced by a User is blocked (role_in_use)...\n");
    try {
      userInUseRole = await prisma.customRole.create({
        data: { key: `TEST_USER_IN_USE_${RUN_ID}`, name: `User In Use ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.GLOBAL },
        select: { id: true, key: true },
      });
    } catch (err: any) {
      if (err?.code === "P2022") {
        console.log(
          "CustomRole.isActive isn't usable against this database yet (migration " +
            "20260723090000_add_custom_role_is_active not applied) — Prisma includes the " +
            "schema's @default(true) for isActive in every CustomRole INSERT regardless of " +
            "select, so no new CustomRole rows can be created until it's applied. Skipping " +
            "the remaining sub-tests; the built-in hard-delete check above already ran."
        );
        printSummaryAndExit();
        return;
      }
      throw err;
    }
    testUser = await prisma.user.create({
      data: {
        email: `test-inuse-${RUN_ID}@kinsen.gr`,
        name: "Test In-Use User",
        role: Role.USER,
        customRoleId: userInUseRole.id,
        isActive: true,
        authProvider: "CREDENTIALS",
      },
    });
    check("Custom role referenced by a User reports in-use === true", await isInUse(userInUseRole.id));

    console.log("\nTesting a custom role referenced by a DepartmentMembership is blocked (role_in_use)...\n");
    membershipInUseRole = await prisma.customRole.create({
      data: { key: `TEST_MEMBERSHIP_IN_USE_${RUN_ID}`, name: `Membership In Use ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.DEPARTMENT },
      select: { id: true, key: true },
    });
    testDepartmentMembership = await prisma.departmentMembership.create({
      data: {
        userId: testUser.id,
        departmentId: "dept-it",
        role: DepartmentRole.VIEWER,
        customRoleId: membershipInUseRole.id,
        source: "MANUAL",
      },
    });
    check("Custom role referenced by a DepartmentMembership reports in-use === true", await isInUse(membershipInUseRole.id));

    console.log("\nTesting an unused custom role hard-deletes successfully (regression, unchanged)...\n");
    unusedRole = await prisma.customRole.create({
      data: { key: `TEST_UNUSED_${RUN_ID}`, name: `Unused ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.GLOBAL },
      select: { id: true, key: true },
    });
    check("Freshly created unused custom role reports in-use === false", !(await isInUse(unusedRole.id)));
    await prisma.rolePermission.deleteMany({ where: { roleKey: unusedRole.key } });
    await prisma.customRole.delete({ where: { id: unusedRole.id } });
    const stillThere = await prisma.customRole.findUnique({ where: { id: unusedRole.id }, select: { id: true } });
    check("Unused custom role no longer exists after hard delete", stillThere === null);
    unusedRole = undefined; // already deleted — skip in cleanup
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMembership", () => (testDepartmentMembership ? prisma.departmentMembership.deleteMany({ where: { id: testDepartmentMembership.id } }) : Promise.resolve())],
      ["testUser", () => (testUser ? prisma.user.deleteMany({ where: { id: testUser.id } }) : Promise.resolve())],
      [
        "customRoles",
        () =>
          prisma.customRole.deleteMany({
            where: {
              id: {
                in: [unusedRole?.id, userInUseRole?.id, membershipInUseRole?.id].filter((id): id is string => !!id),
              },
            },
          }),
      ],
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
