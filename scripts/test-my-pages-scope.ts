/**
 * getNavVisibilityFlags (department-scope-service.ts) drives both the
 * sidebar's Organization/Administration nav items AND is the same
 * data-shape logic /my-departments, /my-subdepartments and
 * /admin/sub-departments use to decide what to show — a regular user only
 * sees their own memberships, a Department Manager sees/manages their own
 * department fully, Director/Admin see everything, and a user with zero
 * memberships sees neither "My" nav item.
 *
 * Tests:
 *  1. A user with zero memberships gets all three flags false.
 *  2. A REQUESTER-tier member (membership, no subdepartment permission, no
 *     SubDepartmentMembership) gets canViewMyDepartments true but the two
 *     sub-department flags false.
 *  3. That same tier of user, once given an active SubDepartmentMembership,
 *     gets canViewMySubDepartments true purely from personal membership —
 *     still no admin-side canViewAdminSubDepartments (no subdepartment.view permission).
 *  4. A DEPARTMENT_MANAGER (has subdepartment.view/create/update/delete) gets all three true.
 *  5. DIRECTOR/ADMIN (canViewAllDepartments) get all three true regardless of membership.
 *
 * Usage: npx tsx scripts/test-my-pages-scope.ts
 * Requires a reachable DATABASE_URL AND the
 * 20260721100000_add_subdepartments_and_custom_department_roles migration
 * applied — reports clearly and exits if either is missing.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";
import { getNavVisibilityFlags } from "@/lib/services/department-scope-service";
import { createSubDepartment } from "@/lib/services/sub-department-service";
import { grantSubDepartmentMembership } from "@/lib/services/sub-department-membership-service";

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
  console.log("Testing DIRECTOR/ADMIN cross-department bypass (pure, no DB)...\n");
  const directorFlags = await getNavVisibilityFlags("nonexistent-user-id", Role.DIRECTOR, null);
  const adminFlags = await getNavVisibilityFlags("nonexistent-user-id", Role.ADMIN, null);
  check("DIRECTOR gets all three flags true regardless of membership", directorFlags.canViewAdminSubDepartments && directorFlags.canViewMyDepartments && directorFlags.canViewMySubDepartments);
  check("ADMIN gets all three flags true regardless of membership", adminFlags.canViewAdminSubDepartments && adminFlags.canViewMyDepartments && adminFlags.canViewMySubDepartments);

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
    await prisma.subDepartment.findFirst({ select: { id: true, isActive: true } });
  } catch (err) {
    migrationApplied = false;
    console.log(
      "\nSubDepartment.isActive isn't usable against this database yet (migration " +
        "20260721100000_add_subdepartments_and_custom_department_roles not applied) — skipping."
    );
    console.log(String(err instanceof Error ? err.message : err));
  }
  if (!migrationApplied) {
    printSummaryAndExit();
    return;
  }

  let dept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let subDept: Awaited<ReturnType<typeof createSubDepartment>> | undefined;
  let noMembershipUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let requesterUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let managerUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const membershipIds: string[] = [];

  try {
    dept = await prisma.department.create({ data: { name: `Test My Pages Dept ${RUN_ID}`, slug: `test-my-pages-dept-${RUN_ID}` } });
    subDept = await createSubDepartment({ departmentId: dept.id, name: `My Pages Sub ${RUN_ID}` });

    noMembershipUser = await prisma.user.create({ data: { email: `test-my-pages-none-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    requesterUser = await prisma.user.create({ data: { email: `test-my-pages-requester-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    managerUser = await prisma.user.create({ data: { email: `test-my-pages-manager-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });

    const requesterMembership = await prisma.departmentMembership.create({
      data: { userId: requesterUser.id, departmentId: dept.id, role: DepartmentRole.REQUESTER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(requesterMembership.id);
    const managerMembership = await prisma.departmentMembership.create({
      data: { userId: managerUser.id, departmentId: dept.id, role: DepartmentRole.DEPARTMENT_MANAGER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(managerMembership.id);

    console.log("\nTesting a user with zero memberships...\n");
    const noneFlags = await getNavVisibilityFlags(noMembershipUser.id, Role.USER, null);
    check("canViewAdminSubDepartments is false", !noneFlags.canViewAdminSubDepartments);
    check("canViewMyDepartments is false", !noneFlags.canViewMyDepartments);
    check("canViewMySubDepartments is false", !noneFlags.canViewMySubDepartments);

    console.log("\nTesting a REQUESTER-tier member (no subdepartment permission, no personal SubDepartmentMembership)...\n");
    const requesterFlags = await getNavVisibilityFlags(requesterUser.id, Role.USER, null);
    check("canViewMyDepartments is true (has a department membership)", requesterFlags.canViewMyDepartments);
    check("canViewAdminSubDepartments is false (no subdepartment.view permission)", !requesterFlags.canViewAdminSubDepartments);
    check("canViewMySubDepartments is false (no permission, no personal sub-department membership)", !requesterFlags.canViewMySubDepartments);

    console.log("\nTesting the same user after gaining a personal SubDepartmentMembership...\n");
    const grant = await grantSubDepartmentMembership(requesterUser.id, subDept.id);
    check("Setup: grant succeeded", grant.ok === true);
    const requesterFlagsAfter = await getNavVisibilityFlags(requesterUser.id, Role.USER, null);
    check("canViewMySubDepartments now true (personal membership alone is enough)", requesterFlagsAfter.canViewMySubDepartments);
    check("canViewAdminSubDepartments still false (still no subdepartment.view permission)", !requesterFlagsAfter.canViewAdminSubDepartments);

    console.log("\nTesting a DEPARTMENT_MANAGER (has subdepartment.view/create/update/delete)...\n");
    const managerFlags = await getNavVisibilityFlags(managerUser.id, Role.USER, null);
    check("canViewAdminSubDepartments is true", managerFlags.canViewAdminSubDepartments);
    check("canViewMyDepartments is true", managerFlags.canViewMyDepartments);
    check("canViewMySubDepartments is true", managerFlags.canViewMySubDepartments);
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["subDepartmentMemberships", () => (subDept ? prisma.subDepartmentMembership.deleteMany({ where: { subDepartmentId: subDept.id } }) : Promise.resolve())],
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      ["subDepartment", () => (subDept ? prisma.subDepartment.deleteMany({ where: { id: subDept.id } }) : Promise.resolve())],
      [
        "users",
        () =>
          prisma.user.deleteMany({
            where: { id: { in: [noMembershipUser?.id, requesterUser?.id, managerUser?.id].filter((id): id is string => !!id) } },
          }),
      ],
      ["department", () => (dept ? prisma.department.deleteMany({ where: { id: dept.id } }) : Promise.resolve())],
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
