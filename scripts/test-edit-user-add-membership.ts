/**
 * Edit User's new "Add Membership" action (components/admin/user-department-memberships.tsx)
 * calls the EXISTING POST /api/admin/departments/[id]/members route — no
 * new backend endpoint, so this test exercises the exact service function
 * that route calls (grantManualMembership) plus the untouched
 * revoke/reactivate path (revokeMembership + grantManualMembership again),
 * confirming the reused endpoint's upsert semantics work correctly for the
 * "add from Edit User" flow and that nothing regressed for the existing
 * table actions.
 *
 * Tests:
 *  1. Add a new membership for a department the user has none in yet.
 *  2. Change its role afterward (same upsert path the per-row Select uses).
 *  3. Revoke it (soft — row survives, isActive false).
 *  4. Reactivate it (no duplicate row created).
 *  5. A Microsoft-sourced membership is preserved unless its role actually
 *     changes — re-verifies ensurePrimaryDepartmentMembership (built last
 *     phase) is unaffected by this phase's changes.
 *
 * Usage: npx tsx scripts/test-edit-user-add-membership.ts
 * Requires a reachable DATABASE_URL AND the
 * 20260721100000_add_subdepartments_and_custom_department_roles migration
 * applied — reports clearly and exits if either is missing.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";
import { grantManualMembership, revokeMembership, ensurePrimaryDepartmentMembership } from "@/lib/services/department-membership-service";

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

  let dept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let user: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let msUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const membershipIds: string[] = [];

  try {
    dept = await prisma.department.create({ data: { name: `Test Edit Add Dept ${RUN_ID}`, slug: `test-edit-add-dept-${RUN_ID}` } });
    user = await prisma.user.create({ data: { email: `test-edit-add-user-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });

    console.log("\nTesting adding a new membership from Edit User...\n");
    const added = await grantManualMembership(user.id, dept.id, { role: DepartmentRole.VIEWER });
    membershipIds.push(added.id);
    check("Membership created active", added.isActive === true);
    check("Source MANUAL", added.source === MembershipSource.MANUAL);
    check("Role VIEWER as chosen", added.role === DepartmentRole.VIEWER);

    console.log("\nTesting changing its role afterward...\n");
    const roleChanged = await grantManualMembership(user.id, dept.id, { role: DepartmentRole.AGENT_ASSIGNEE });
    check("Same row updated (no duplicate)", roleChanged.id === added.id);
    check("Role updated to AGENT_ASSIGNEE", roleChanged.role === DepartmentRole.AGENT_ASSIGNEE);

    console.log("\nTesting revoke (soft)...\n");
    const revoked = await revokeMembership(added.id);
    check("isActive false after revoke", revoked.isActive === false);
    const stillExists = await prisma.departmentMembership.findUnique({ where: { id: added.id } });
    check("Row still exists after revoke (soft, not deleted)", stillExists !== null);

    console.log("\nTesting reactivate (no duplicate)...\n");
    const reactivated = await grantManualMembership(user.id, dept.id, { role: DepartmentRole.AGENT_ASSIGNEE });
    check("Same row reactivated (no duplicate)", reactivated.id === added.id);
    check("isActive true again", reactivated.isActive === true);
    const countForPair = await prisma.departmentMembership.count({ where: { userId: user.id, departmentId: dept.id } });
    check("Exactly one membership row for this user/department pair", countForPair === 1);

    console.log("\nTesting Microsoft-sourced membership preservation is unaffected by this phase...\n");
    msUser = await prisma.user.create({ data: { email: `test-edit-add-ms-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.MICROSOFT, role: Role.IT_AGENT } });
    const msMembership = await prisma.departmentMembership.create({
      data: { userId: msUser.id, departmentId: dept.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MICROSOFT_DEPARTMENT, isActive: true },
    });
    membershipIds.push(msMembership.id);
    const untouched = await ensurePrimaryDepartmentMembership(msUser.id, dept.id, DepartmentRole.AGENT_ASSIGNEE);
    check("Same role -> source stays MICROSOFT_DEPARTMENT", untouched.source === MembershipSource.MICROSOFT_DEPARTMENT);
    const changed = await ensurePrimaryDepartmentMembership(msUser.id, dept.id, DepartmentRole.DEPARTMENT_MANAGER);
    check("Different role -> source becomes MANUAL", changed.source === MembershipSource.MANUAL);
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: [user?.id, msUser?.id].filter((id): id is string => !!id) } } })],
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
