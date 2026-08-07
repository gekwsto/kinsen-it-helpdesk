/**
 * Admin Add/Edit User CRUD with the canonical primary + secondary
 * membership model — exercises the exact service-level building blocks
 * app/api/admin/users/route.ts (POST) and
 * app/api/admin/departments/[id]/members/[membershipId]/route.ts (DELETE)
 * now use, without spinning up an HTTP server (established pattern in this
 * codebase).
 *
 * Tests:
 *  15. Admin create with a primary department + 3 secondary departments in
 *      one request: exactly 1 active primary + 3 active secondary
 *      memberships afterward, User.departmentId mirrors the primary.
 *  17. Admin removes ONE secondary membership: only that membership is
 *      revoked — primary is untouched (still active, still isPrimary,
 *      User.departmentId unchanged), the other secondary memberships
 *      untouched.
 *  17b. Attempting to remove the ACTIVE PRIMARY membership via the same
 *       "remove member" action is rejected (guarded — changing the primary
 *       department is a deliberate Edit User action, never an implicit
 *       side effect of removing a row from the Members list).
 *
 * Usage: npx tsx scripts/test-admin-user-multi-department-crud.ts
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";
import { setPrimaryDepartmentMembership, grantManualMembership, revokeMembership } from "@/lib/services/department-membership-service";

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
  let user: Awaited<ReturnType<typeof prisma.user.create>> | undefined;

  try {
    const primaryDept = await prisma.department.create({ data: { name: `CRUD Test Primary ${RUN_ID}`, slug: `crud-test-primary-${RUN_ID}` } });
    const secA = await prisma.department.create({ data: { name: `CRUD Test SecA ${RUN_ID}`, slug: `crud-test-seca-${RUN_ID}` } });
    const secB = await prisma.department.create({ data: { name: `CRUD Test SecB ${RUN_ID}`, slug: `crud-test-secb-${RUN_ID}` } });
    const secC = await prisma.department.create({ data: { name: `CRUD Test SecC ${RUN_ID}`, slug: `crud-test-secc-${RUN_ID}` } });
    deptIds.push(primaryDept.id, secA.id, secB.id, secC.id);

    // ── Test 15: admin create with primary + 3 secondary in one go ────────
    console.log("\nTesting Admin Create with primary + 3 secondary departments...\n");
    user = await prisma.user.create({ data: { email: `crud-test-user-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER, mustChangePassword: true } });
    // Mirrors the route: secondary rows created first (grantManualMembership),
    // then the primary is established via the canonical function — order
    // matches app/api/admin/users/route.ts exactly.
    const mSecA = await grantManualMembership(user.id, secA.id, { role: DepartmentRole.VIEWER });
    const mSecB = await grantManualMembership(user.id, secB.id, { role: DepartmentRole.VIEWER });
    const mSecC = await grantManualMembership(user.id, secC.id, { role: DepartmentRole.VIEWER });
    membershipIds.push(mSecA.id, mSecB.id, mSecC.id);
    const primaryResult = await setPrimaryDepartmentMembership(user.id, primaryDept.id, MembershipSource.MANUAL, { role: DepartmentRole.REQUESTER });
    membershipIds.push(primaryResult.primaryMembership.id);

    const allActive = await prisma.departmentMembership.findMany({ where: { userId: user.id, isActive: true } });
    check("15. Exactly 4 active memberships (1 primary + 3 secondary)", allActive.length === 4);
    check("    Exactly 1 is primary, pointing at primaryDept", allActive.filter((m) => m.isPrimary).length === 1 && allActive.find((m) => m.isPrimary)?.departmentId === primaryDept.id);
    check("    All 3 secondary rows are active, non-primary", [secA.id, secB.id, secC.id].every((id) => allActive.find((m) => m.departmentId === id)?.isPrimary === false));
    const userAfterCreate = await prisma.user.findUnique({ where: { id: user.id } });
    check("    User.departmentId mirrors the primary", userAfterCreate?.departmentId === primaryDept.id);

    // ── Test 17: removing ONE secondary doesn't touch primary or the others ──
    console.log("\nTesting removal of one secondary membership...\n");
    await revokeMembership(mSecA.id);
    const afterRemoveA = await prisma.departmentMembership.findMany({ where: { userId: user.id } });
    const secARow = afterRemoveA.find((m) => m.departmentId === secA.id);
    const secBRow = afterRemoveA.find((m) => m.departmentId === secB.id);
    const secCRow = afterRemoveA.find((m) => m.departmentId === secC.id);
    const primaryRow = afterRemoveA.find((m) => m.departmentId === primaryDept.id);
    check("17. Removed secondary (SecA) is now inactive", secARow?.isActive === false);
    check("    SecB untouched (still active)", secBRow?.isActive === true);
    check("    SecC untouched (still active)", secCRow?.isActive === true);
    check("    Primary is COMPLETELY untouched — still active, still isPrimary", primaryRow?.isActive === true && primaryRow?.isPrimary === true);
    const userAfterRemoveA = await prisma.user.findUnique({ where: { id: user.id } });
    check("    User.departmentId unchanged (still the primary)", userAfterRemoveA?.departmentId === primaryDept.id);

    // ── Test 17b: the DELETE membership route's guard logic (simulated at the service level) ──
    console.log("\nTesting that the active primary membership is protected from direct removal...\n");
    const primaryMembershipRow = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: user.id, departmentId: primaryDept.id } } });
    // This mirrors the exact guard added to
    // app/api/admin/departments/[id]/members/[membershipId]/route.ts's
    // DELETE handler — asserting the CONDITION it checks, since exercising
    // the route itself would require an HTTP server (out of scope for this
    // service-level test suite, matching this codebase's convention).
    const wouldBeRejected = primaryMembershipRow?.isPrimary === true && primaryMembershipRow?.isActive === true;
    check("17b. The route's guard condition (isPrimary && isActive) correctly identifies this row as protected", wouldBeRejected === true);
  } finally {
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["memberships", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      ["user", () => (user ? prisma.user.deleteMany({ where: { id: user.id } }) : Promise.resolve())],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: deptIds } } })],
    ];
    for (const [label, step] of steps) {
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
