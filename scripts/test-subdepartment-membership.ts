/**
 * SubDepartmentMembership: pure assignment (no role tier — see the model's
 * doc-comment in prisma/schema.prisma), but grantSubDepartmentMembership
 * still enforces the "prefer block for safety" rule that a user must
 * already be an ACTIVE member of the parent Department before joining one
 * of its SubDepartments.
 *
 * Tests:
 *  1. Grant is blocked with reason "user_not_in_department" when the target
 *     user has no DepartmentMembership in the sub-department's department.
 *  2. Grant succeeds once the user has an active parent DepartmentMembership.
 *  3. Grant is idempotent (upsert) and revoke is soft (isActive:false, row survives).
 *  4. Grant is blocked for a disabled SubDepartment ("subdepartment_inactive").
 *  5. hasDepartmentPermission: a user with only "subdepartment.view" (e.g.
 *     Director) cannot assign/unassign; a user with
 *     "subdepartment.user.assign" (Department Manager/Admin) can — exercised
 *     via the same permission-key checks requireDepartmentPermission uses.
 *  6. A cross-department subDepartmentId on a Ticket/Project/Activity is
 *     rejected by validateSubDepartmentInDepartment (shared with
 *     test-subdepartment-crud.ts, re-verified here in the assignment context).
 *
 * Usage: npx tsx scripts/test-subdepartment-membership.ts
 * Requires a reachable DATABASE_URL AND the
 * 20260721100000_add_subdepartments_and_custom_department_roles migration
 * applied — reports clearly and exits if either is missing.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";
import { hasDepartmentPermission, hasPermission } from "@/lib/permissions";
import { createSubDepartment, setSubDepartmentActive, validateSubDepartmentInDepartment } from "@/lib/services/sub-department-service";
import { grantSubDepartmentMembership, revokeSubDepartmentMembership, getSubDepartmentMembership } from "@/lib/services/sub-department-membership-service";

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
    await prisma.subDepartmentMembership.findFirst({ select: { id: true } });
  } catch (err) {
    migrationApplied = false;
    console.log(
      "\nSubDepartmentMembership isn't usable against this database yet (migration " +
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
  let subDeptA: Awaited<ReturnType<typeof createSubDepartment>> | undefined;
  let subDeptB: Awaited<ReturnType<typeof createSubDepartment>> | undefined;
  let memberUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let outsiderUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const membershipIds: string[] = [];
  const subDeptIds: string[] = [];

  try {
    deptA = await prisma.department.create({ data: { name: `Test SubDept Membership Dept A ${RUN_ID}`, slug: `test-subdept-membership-a-${RUN_ID}` } });
    deptB = await prisma.department.create({ data: { name: `Test SubDept Membership Dept B ${RUN_ID}`, slug: `test-subdept-membership-b-${RUN_ID}` } });
    subDeptA = await createSubDepartment({ departmentId: deptA.id, name: `Support Team ${RUN_ID}` });
    subDeptIds.push(subDeptA.id);
    subDeptB = await createSubDepartment({ departmentId: deptB.id, name: `Ops Team ${RUN_ID}` });
    subDeptIds.push(subDeptB.id);

    memberUser = await prisma.user.create({ data: { email: `test-subdept-member-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    outsiderUser = await prisma.user.create({ data: { email: `test-subdept-outsider-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });

    console.log("\nTesting grant is blocked without an active parent DepartmentMembership...\n");
    const blockedResult = await grantSubDepartmentMembership(outsiderUser.id, subDeptA.id);
    check("Blocked with reason user_not_in_department", !blockedResult.ok && blockedResult.reason === "user_not_in_department");

    console.log("\nTesting grant succeeds once the user has an active parent membership...\n");
    const parentMembership = await prisma.departmentMembership.create({
      data: { userId: memberUser.id, departmentId: deptA.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(parentMembership.id);

    const granted = await grantSubDepartmentMembership(memberUser.id, subDeptA.id);
    check("Grant succeeds", granted.ok === true);
    if (granted.ok) {
      check("departmentId is denormalized to match the sub-department's parent", granted.membership.departmentId === deptA.id);
      check("source is MANUAL", granted.membership.source === MembershipSource.MANUAL);
    }

    console.log("\nTesting grant is idempotent (upsert) and revoke is soft...\n");
    const grantedAgain = await grantSubDepartmentMembership(memberUser.id, subDeptA.id);
    check("Re-granting the same membership succeeds (upsert, no duplicate error)", grantedAgain.ok === true);
    const countAfterDoubleGrant = await prisma.subDepartmentMembership.count({ where: { userId: memberUser.id, subDepartmentId: subDeptA.id } });
    check("Exactly one membership row exists (unique([userId, subDepartmentId]))", countAfterDoubleGrant === 1);

    if (granted.ok) {
      await revokeSubDepartmentMembership(granted.membership.id);
      const afterRevoke = await getSubDepartmentMembership(memberUser.id, subDeptA.id);
      check("Revoked membership is no longer returned as active", afterRevoke === null);
      const rawRow = await prisma.subDepartmentMembership.findUnique({ where: { id: granted.membership.id } });
      check("Revoked membership row still exists (soft-revoke, not deleted)", rawRow !== null && rawRow.isActive === false);
    }

    console.log("\nTesting grant is blocked for a disabled SubDepartment...\n");
    await setSubDepartmentActive(subDeptA.id, false);
    const blockedByDisabled = await grantSubDepartmentMembership(memberUser.id, subDeptA.id);
    check("Blocked with reason subdepartment_inactive", !blockedByDisabled.ok && blockedByDisabled.reason === "subdepartment_inactive");
    await setSubDepartmentActive(subDeptA.id, true);

    console.log("\nTesting permission-key gating for assign/unassign vs. view-only...\n");
    check(
      "DIRECTOR (global role, has subdepartment.view only) cannot subdepartment.user.assign",
      !(await hasPermission(Role.DIRECTOR, "subdepartment.user.assign", null))
    );
    check(
      "DEPARTMENT_MANAGER (has subdepartment.user.assign) can subdepartment.user.assign",
      await hasDepartmentPermission(DepartmentRole.DEPARTMENT_MANAGER, "subdepartment.user.assign", null)
    );
    check(
      "DEPARTMENT_MANAGER (has subdepartment.user.unassign) can subdepartment.user.unassign",
      await hasDepartmentPermission(DepartmentRole.DEPARTMENT_MANAGER, "subdepartment.user.unassign", null)
    );
    check(
      "VIEWER (department role, no subdepartment permissions) cannot subdepartment.user.assign",
      !(await hasDepartmentPermission(DepartmentRole.VIEWER, "subdepartment.user.assign", null))
    );

    console.log("\nTesting cross-department subDepartmentId is rejected in the assignment context...\n");
    check(
      "subDeptB (belongs to deptB) is invalid for an entity scoped to deptA",
      !(await validateSubDepartmentInDepartment(subDeptB.id, deptA.id))
    );
    check(
      "subDeptA is valid for an entity scoped to its own department (deptA)",
      await validateSubDepartmentInDepartment(subDeptA.id, deptA.id)
    );
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["subDepartmentMemberships", () => prisma.subDepartmentMembership.deleteMany({ where: { subDepartmentId: { in: subDeptIds } } })],
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      ["subDepartments", () => prisma.subDepartment.deleteMany({ where: { id: { in: subDeptIds } } })],
      [
        "users",
        () => prisma.user.deleteMany({ where: { id: { in: [memberUser?.id, outsiderUser?.id].filter((id): id is string => !!id) } } }),
      ],
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
