/**
 * Canonical primary + secondary membership model, director scenario:
 * one primary organizational department (e.g. Management) plus N manually
 * granted secondary departments (e.g. Finance, IT, Sales) — the director
 * must retain real access to every one of them, and the primary/secondary
 * split must be reflected consistently across authorization, the Department
 * Members page's underlying data, and the Organization tree's placement
 * semantics (primary-only, no duplication).
 *
 * Tests:
 *  6. Director has 1 active primary (Management) + 3 active secondary
 *     (Finance, IT, Sales) memberships — all four are real, queryable
 *     DepartmentMembership rows.
 *  7. Department authorization (getUserDepartmentMemberships /
 *     canAssignUserToDepartment-backing data) includes the director in
 *     every one of the 3 secondary departments, not just the primary.
 *  8. Organization tree placement (User.departmentId, the primary mirror)
 *     points ONLY at Management — the director is not organizationally
 *     "in" Finance/IT/Sales, even though they have real access there
 *     (organizational placement vs access membership are different
 *     concepts — see organization-tree-service.ts's header comment).
 *
 * Usage: npx tsx scripts/test-director-multi-department-authorization.ts
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";
import { setPrimaryDepartmentMembership, grantManualMembership, getUserDepartmentMemberships } from "@/lib/services/department-membership-service";
import { getDepartmentTree, invalidateOrganizationTreeCache } from "@/lib/services/organization-tree-service";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}
function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const RUN_ID = Date.now();

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const deptIds: string[] = [];
  const membershipIds: string[] = [];
  let director: Awaited<ReturnType<typeof prisma.user.create>> | undefined;

  try {
    const management = await prisma.department.create({ data: { name: `Director Test Management ${RUN_ID}`, slug: `director-test-management-${RUN_ID}` } });
    const finance = await prisma.department.create({ data: { name: `Director Test Finance ${RUN_ID}`, slug: `director-test-finance-${RUN_ID}` } });
    const it = await prisma.department.create({ data: { name: `Director Test IT ${RUN_ID}`, slug: `director-test-it-${RUN_ID}` } });
    const sales = await prisma.department.create({ data: { name: `Director Test Sales ${RUN_ID}`, slug: `director-test-sales-${RUN_ID}` } });
    deptIds.push(management.id, finance.id, it.id, sales.id);

    director = await prisma.user.create({ data: { email: `director-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.DIRECTOR } });

    console.log("\nSetting up: Primary=Management, Secondary=Finance/IT/Sales...\n");
    const primaryResult = await setPrimaryDepartmentMembership(director.id, management.id, MembershipSource.MANUAL, { role: DepartmentRole.DEPARTMENT_ADMIN });
    membershipIds.push(primaryResult.primaryMembership.id);
    const financeMembership = await grantManualMembership(director.id, finance.id, { role: DepartmentRole.VIEWER });
    const itMembership = await grantManualMembership(director.id, it.id, { role: DepartmentRole.VIEWER });
    const salesMembership = await grantManualMembership(director.id, sales.id, { role: DepartmentRole.VIEWER });
    membershipIds.push(financeMembership.id, itMembership.id, salesMembership.id);

    // ── Test 6: all four are real active memberships, exactly one primary ──
    const allMemberships = await prisma.departmentMembership.findMany({ where: { userId: director.id, isActive: true } });
    check("6. Director has exactly 4 active memberships", allMemberships.length === 4);
    check("   Exactly 1 is primary (Management)", allMemberships.filter((m) => m.isPrimary).length === 1 && allMemberships.find((m) => m.isPrimary)?.departmentId === management.id);
    check("   Finance/IT/Sales are active secondary (isPrimary:false)", [finance.id, it.id, sales.id].every((id) => allMemberships.find((m) => m.departmentId === id)?.isPrimary === false));

    // ── Test 7: authorization includes the director in every secondary department ──
    const authMemberships = await getUserDepartmentMemberships(director.id);
    check("7. department-scope authorization sees Management (primary)", authMemberships.some((m) => m.departmentId === management.id));
    check("   ...AND Finance (secondary)", authMemberships.some((m) => m.departmentId === finance.id));
    check("   ...AND IT (secondary)", authMemberships.some((m) => m.departmentId === it.id));
    check("   ...AND Sales (secondary)", authMemberships.some((m) => m.departmentId === sales.id));
    check("   Total authorized departments = 4 (primary + 3 secondary, all count for access)", authMemberships.length === 4);

    // ── Test 8: organization tree placement is primary-only, no duplication ──
    invalidateOrganizationTreeCache();
    const director2 = await prisma.user.findUnique({ where: { id: director.id }, select: { departmentId: true } });
    check("8. User.departmentId (organizational placement mirror) points ONLY at Management", director2?.departmentId === management.id);

    const tree = await getDepartmentTree({ activeOnly: false });
    function findNode(nodes: any[], id: string): any {
      for (const n of nodes) {
        if (n.id === id) return n;
        const found = findNode(n.children, id);
        if (found) return found;
      }
      return null;
    }
    const managementNode = findNode(tree, management.id);
    const financeNode = findNode(tree, finance.id);
    const itNode = findNode(tree, it.id);
    const salesNode = findNode(tree, sales.id);
    check("   Organization tree counts the director under Management (primary)", (managementNode?.totalUserCount ?? 0) >= 1);
    check("   Organization tree does NOT count the director under Finance (secondary-only, not primary)", (financeNode?.totalUserCount ?? 0) === 0);
    check("   ...nor under IT", (itNode?.totalUserCount ?? 0) === 0);
    check("   ...nor under Sales — no duplication across the org chart", (salesNode?.totalUserCount ?? 0) === 0);
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["memberships", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      ["director", () => (director ? prisma.user.deleteMany({ where: { id: director.id } }) : Promise.resolve())],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: deptIds } } })],
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
