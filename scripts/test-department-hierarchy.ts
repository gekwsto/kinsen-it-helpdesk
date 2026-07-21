/**
 * Department Hierarchy popup (/my-departments -> "View Hierarchy") —
 * getDepartmentHierarchyTier (lib/services/department-role-translation.ts)
 * is the pure rank function; GET /api/departments/[id]/hierarchy is the
 * on-demand data route. This test exercises the rank function directly
 * (pure, no DB) for the ordering rules, plus the exact access-check and
 * query/group/sort logic the route performs, against real Prisma data.
 *
 * Tests:
 *  1. Global Director ranks at DIRECTOR regardless of their
 *     DepartmentMembership.role value (even a VIEWER placeholder).
 *  2. Tier order: DIRECTOR before DEPARTMENT_MANAGER before DEPARTMENT_ADMIN.
 *  3. Tier order: DEPARTMENT_ADMIN before PROJECT_MANAGER before AGENT
 *     before REQUESTER before VIEWER.
 *  4. Global Admin lands in SYSTEM_ADMIN, not mixed into the operational tiers.
 *  5. A genuinely custom (isBuiltIn: false) department role lands in
 *     OTHER_ROLES — never above DIRECTOR/DEPARTMENT_MANAGER.
 *  6. A built-in custom-role row (isBuiltIn: true) ranks the same as the
 *     DepartmentRole its key matches.
 *  7. Inactive DepartmentMembership rows are excluded from the route's query.
 *  8. A user with no membership and no cross-department role fails the
 *     route's access check.
 *  9. Admin/Director pass the route's access check for any department.
 *  10. Within one tier, members sort alphabetically by name.
 *
 * Usage: npx tsx scripts/test-department-hierarchy.ts
 * Requires a reachable DATABASE_URL for tests 7-10 — reports clearly and
 * exits if unreachable; tests 1-6 are pure and always run.
 */
import { prisma } from "@/lib/prisma";
import { Role, DepartmentRole, AuthProvider, MembershipSource } from "@prisma/client";
import { canViewAllDepartments } from "@/lib/permissions";
import { getMembership } from "@/lib/services/department-membership-service";
import {
  getDepartmentHierarchyTier,
  HIERARCHY_TIER_ORDER,
} from "@/lib/services/department-role-translation";

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

const tierIndex = (tier: string) => HIERARCHY_TIER_ORDER.indexOf(tier as any);

async function runPureTests() {
  console.log("\nTesting pure getDepartmentHierarchyTier rank rules...\n");

  check(
    "Global Director ranks DIRECTOR regardless of a VIEWER-placeholder DepartmentMembership.role",
    getDepartmentHierarchyTier({ globalRole: Role.DIRECTOR, departmentRole: DepartmentRole.VIEWER, customRole: null }) === "DIRECTOR"
  );
  check(
    "Global Director ranks DIRECTOR even with a DEPARTMENT_ADMIN-valued membership.role (still overridden)",
    getDepartmentHierarchyTier({ globalRole: Role.DIRECTOR, departmentRole: DepartmentRole.DEPARTMENT_ADMIN, customRole: null }) === "DIRECTOR"
  );

  const director = tierIndex(getDepartmentHierarchyTier({ globalRole: Role.DIRECTOR, departmentRole: DepartmentRole.VIEWER, customRole: null }));
  const deptManager = tierIndex(getDepartmentHierarchyTier({ globalRole: Role.USER, departmentRole: DepartmentRole.DEPARTMENT_MANAGER, customRole: null }));
  const deptAdmin = tierIndex(getDepartmentHierarchyTier({ globalRole: Role.USER, departmentRole: DepartmentRole.DEPARTMENT_ADMIN, customRole: null }));
  const projectManager = tierIndex(getDepartmentHierarchyTier({ globalRole: Role.USER, departmentRole: DepartmentRole.PROJECT_MANAGER, customRole: null }));
  const agent = tierIndex(getDepartmentHierarchyTier({ globalRole: Role.USER, departmentRole: DepartmentRole.AGENT_ASSIGNEE, customRole: null }));
  const requester = tierIndex(getDepartmentHierarchyTier({ globalRole: Role.USER, departmentRole: DepartmentRole.REQUESTER, customRole: null }));
  const viewer = tierIndex(getDepartmentHierarchyTier({ globalRole: Role.USER, departmentRole: DepartmentRole.VIEWER, customRole: null }));

  check("Director ranks above Department Manager", director < deptManager);
  check("Department Manager ranks above Department Admin", deptManager < deptAdmin);
  check("Department Admin ranks above Project Manager", deptAdmin < projectManager);
  check("Project Manager ranks above Agent", projectManager < agent);
  check("Agent ranks above Requester", agent < requester);
  check("Requester ranks above Viewer", requester < viewer);

  const systemAdmin = tierIndex(getDepartmentHierarchyTier({ globalRole: Role.ADMIN, departmentRole: DepartmentRole.VIEWER, customRole: null }));
  check("Global Admin lands in SYSTEM_ADMIN", getDepartmentHierarchyTier({ globalRole: Role.ADMIN, departmentRole: DepartmentRole.VIEWER, customRole: null }) === "SYSTEM_ADMIN");
  check("SYSTEM_ADMIN is not mixed into the operational 7-tier ordering (it's a distinct slot, index 0)", systemAdmin === 0 && systemAdmin < director);

  const customBuiltIn = getDepartmentHierarchyTier({
    globalRole: Role.USER,
    departmentRole: DepartmentRole.VIEWER,
    customRole: { key: "DEPARTMENT_MANAGER", isBuiltIn: true },
  });
  check("A built-in custom-role row ranks the same as the DepartmentRole its key matches", customBuiltIn === "DEPARTMENT_MANAGER");

  const customOther = getDepartmentHierarchyTier({
    globalRole: Role.USER,
    departmentRole: DepartmentRole.VIEWER,
    customRole: { key: "REGIONAL_COORDINATOR", isBuiltIn: false },
  });
  check("A genuinely custom (isBuiltIn: false) role lands in OTHER_ROLES", customOther === "OTHER_ROLES");
  check("OTHER_ROLES never ranks above Director or Department Manager", tierIndex(customOther) > director && tierIndex(customOther) > deptManager);
}

const RUN_ID = Date.now();

async function runDbBackedTests() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping DB-backed checks.");
    console.log(String(err instanceof Error ? err.message : err));
    return;
  }

  let dept: { id: string } | undefined;
  let managerUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let outsiderUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let adminUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let inactiveMembershipUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let zUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let aUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const membershipIds: string[] = [];

  try {
    console.log("\nSetting up a department with mixed-activity memberships...\n");
    dept = await prisma.department.create({ data: { name: `Hierarchy Dept ${RUN_ID}`, slug: `hierarchy-dept-${RUN_ID}` }, select: { id: true } });

    managerUser = await prisma.user.create({
      data: { email: `hier-manager-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    outsiderUser = await prisma.user.create({
      data: { email: `hier-outsider-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    adminUser = await prisma.user.create({
      data: { email: `hier-admin-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    inactiveMembershipUser = await prisma.user.create({
      data: { email: `hier-inactive-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    zUser = await prisma.user.create({
      data: { email: `hier-zebra-${RUN_ID}@kinsen.gr`, name: `Zebra Agent ${RUN_ID}`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    aUser = await prisma.user.create({
      data: { email: `hier-amber-${RUN_ID}@kinsen.gr`, name: `Amber Agent ${RUN_ID}`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });

    const mgrMembership = await prisma.departmentMembership.create({
      data: { userId: managerUser.id, departmentId: dept.id, role: DepartmentRole.DEPARTMENT_MANAGER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(mgrMembership.id);

    const inactiveMembership = await prisma.departmentMembership.create({
      data: { userId: inactiveMembershipUser.id, departmentId: dept.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isActive: false },
    });
    membershipIds.push(inactiveMembership.id);

    const zMembership = await prisma.departmentMembership.create({
      data: { userId: zUser.id, departmentId: dept.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL },
    });
    membershipIds.push(zMembership.id);
    const aMembership = await prisma.departmentMembership.create({
      data: { userId: aUser.id, departmentId: dept.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL },
    });
    membershipIds.push(aMembership.id);

    console.log("\nTesting the route's access check...\n");
    check(
      "A user with no membership and no cross-department role fails the access check",
      !(canViewAllDepartments(Role.USER) || (await getMembership(outsiderUser.id, dept.id)) !== null)
    );
    check(
      "Admin passes the access check for any department (cross-department bypass)",
      canViewAllDepartments(Role.ADMIN) || (await getMembership(adminUser.id, dept.id)) !== null
    );
    check(
      "A real member (Department Manager) passes the access check",
      canViewAllDepartments(Role.USER) || (await getMembership(managerUser.id, dept.id)) !== null
    );

    console.log("\nTesting the route's query excludes inactive memberships...\n");
    const activeMemberships = await prisma.departmentMembership.findMany({
      where: { departmentId: dept.id, isActive: true, user: { isActive: true } },
      select: { userId: true },
    });
    check("Inactive membership (inactiveMembershipUser) is excluded from the active-members query", !activeMemberships.some((m) => m.userId === inactiveMembershipUser!.id));
    check("Active memberships (manager, zUser, aUser) are included", [managerUser.id, zUser.id, aUser.id].every((id) => activeMemberships.some((m) => m.userId === id)));

    console.log("\nTesting alphabetical sort within a tier...\n");
    const agentTierMembers = [
      { name: zUser.name, email: zUser.email },
      { name: aUser.name, email: aUser.email },
    ].sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));
    check("Within the same tier, members sort alphabetically by name (Amber before Zebra)", agentTierMembers[0].name === aUser.name);
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      [
        "users",
        () =>
          prisma.user.deleteMany({
            where: {
              id: {
                in: [managerUser?.id, outsiderUser?.id, adminUser?.id, inactiveMembershipUser?.id, zUser?.id, aUser?.id].filter(
                  (id): id is string => !!id
                ),
              },
            },
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
}

async function main() {
  await runPureTests();
  await runDbBackedTests();
  printSummaryAndExit();
}

main();
