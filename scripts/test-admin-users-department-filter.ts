/**
 * admin/users' new department filter (?departmentId=all|<id>) must: show
 * everyone under "All" (including null/no-department users), show a
 * department's active-membership users AND legacy-User.departmentId-only
 * users under a specific department, with no duplicate rows for a user
 * matched by both. Mirrors the exact where-clause built in
 * app/(main)/admin/users/page.tsx.
 *
 * Usage: npx tsx scripts/test-admin-users-department-filter.ts
 * Requires a reachable DATABASE_URL — prints a clear message and exits if
 * one isn't configured/reachable.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, MembershipSource, Role } from "@prisma/client";

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

const RUN_ID = Date.now();

// Same where-clause the page builds — kept in sync manually since it's
// inline in a Server Component, not an exported helper.
function buildUserDepartmentWhere(selectedDepartmentId: string) {
  if (selectedDepartmentId === "all") return {};
  return {
    OR: [
      { departmentMemberships: { some: { departmentId: selectedDepartmentId, isActive: true } } },
      { departmentId: selectedDepartmentId },
    ],
  };
}

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping (run this in an environment with a real DB).");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  let deptA: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let deptB: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  const userIds: string[] = [];
  const membershipIds: string[] = [];

  try {
    deptA = await prisma.department.create({ data: { name: `Test Filter Dept A ${RUN_ID}`, slug: `test-filter-dept-a-${RUN_ID}` } });
    deptB = await prisma.department.create({ data: { name: `Test Filter Dept B ${RUN_ID}`, slug: `test-filter-dept-b-${RUN_ID}` } });

    // Active membership in dept A only.
    const activeMemberUser = await prisma.user.create({
      data: { email: `test-filter-active-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER },
    });
    userIds.push(activeMemberUser.id);
    membershipIds.push(
      (
        await prisma.departmentMembership.create({
          data: { userId: activeMemberUser.id, departmentId: deptA.id, role: "REQUESTER", source: MembershipSource.MANUAL, isActive: true },
        })
      ).id
    );

    // Legacy User.departmentId = dept A, no membership row at all.
    const legacyOnlyUser = await prisma.user.create({
      data: { email: `test-filter-legacy-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER, departmentId: deptA.id },
    });
    userIds.push(legacyOnlyUser.id);

    // Both: active membership in dept A AND legacy departmentId = dept A —
    // must appear exactly once under dept A, not twice.
    const bothUser = await prisma.user.create({
      data: { email: `test-filter-both-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER, departmentId: deptA.id },
    });
    userIds.push(bothUser.id);
    membershipIds.push(
      (
        await prisma.departmentMembership.create({
          data: { userId: bothUser.id, departmentId: deptA.id, role: "REQUESTER", source: MembershipSource.MANUAL, isActive: true },
        })
      ).id
    );

    // Revoked (inactive) membership in dept A — must NOT count as dept A.
    const revokedUser = await prisma.user.create({
      data: { email: `test-filter-revoked-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER },
    });
    userIds.push(revokedUser.id);
    membershipIds.push(
      (
        await prisma.departmentMembership.create({
          data: { userId: revokedUser.id, departmentId: deptA.id, role: "REQUESTER", source: MembershipSource.MANUAL, isActive: false },
        })
      ).id
    );

    // No department at all — legacy null, no memberships.
    const noDeptUser = await prisma.user.create({
      data: { email: `test-filter-nodept-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER },
    });
    userIds.push(noDeptUser.id);

    // Member of dept B only — must never show up under dept A.
    const deptBUser = await prisma.user.create({
      data: { email: `test-filter-deptb-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER },
    });
    userIds.push(deptBUser.id);
    membershipIds.push(
      (
        await prisma.departmentMembership.create({
          data: { userId: deptBUser.id, departmentId: deptB.id, role: "REQUESTER", source: MembershipSource.MANUAL, isActive: true },
        })
      ).id
    );

    console.log("Testing \"All\"...\n");
    const all = await prisma.user.findMany({ where: { AND: [buildUserDepartmentWhere("all"), { id: { in: userIds } }] } });
    check("All includes every test user, including the no-department one", all.length === userIds.length);

    console.log("\nTesting a specific department (dept A)...\n");
    const deptAUsers = await prisma.user.findMany({ where: { AND: [buildUserDepartmentWhere(deptA.id), { id: { in: userIds } }] } });
    const deptAIds = deptAUsers.map((u) => u.id);
    check("Includes the active-membership user", deptAIds.includes(activeMemberUser.id));
    check("Includes the legacy-departmentId-only user", deptAIds.includes(legacyOnlyUser.id));
    check("Includes the both-membership-and-legacy user exactly once (no duplicate rows)", deptAIds.filter((id) => id === bothUser.id).length === 1);
    check("Excludes the revoked-membership user", !deptAIds.includes(revokedUser.id));
    check("Excludes the no-department user", !deptAIds.includes(noDeptUser.id));
    check("Excludes the dept B user", !deptAIds.includes(deptBUser.id));

    console.log("\nTesting a specific department (dept B)...\n");
    const deptBUsers = await prisma.user.findMany({ where: { AND: [buildUserDepartmentWhere(deptB.id), { id: { in: userIds } }] } });
    check("Only the dept B user, nothing from dept A", deptBUsers.length === 1 && deptBUsers[0].id === deptBUser.id);
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMembership", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      ["user", () => (userIds.length > 0 ? prisma.user.deleteMany({ where: { id: { in: userIds } } }) : Promise.resolve())],
      ["department", () =>
        prisma.department.deleteMany({ where: { id: { in: [deptA?.id, deptB?.id].filter((x): x is string => !!x) } } })],
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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
