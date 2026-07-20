/**
 * The cross-department admin page (/admin/sub-departments) lists every
 * sub-department the caller can administer — ADMIN/DIRECTOR (all active
 * departments), everyone else only departments where they hold
 * subdepartment.view (via the existing getAccessibleDepartmentSummaries,
 * reused unchanged from the previous phase). This verifies the accessible-
 * department-id computation never leaks another department's
 * sub-departments to a scoped manager, the same guarantee the page's
 * `prisma.subDepartment.findMany({ where: { departmentId: { in: ... } } })`
 * depends on.
 *
 * Tests:
 *  1. A Department Manager scoped to deptA only sees deptA in their accessible set.
 *  2. Filtering sub-departments by that accessible set returns only deptA's, never deptB's.
 *  3. ADMIN's accessible set includes both departments (cross-department access).
 *  4. A user with subdepartment.view in NEITHER department gets an empty accessible set.
 *
 * Usage: npx tsx scripts/test-subdepartment-admin-cross-department.ts
 * Requires a reachable DATABASE_URL AND the
 * 20260721100000_add_subdepartments_and_custom_department_roles migration
 * applied — reports clearly and exits if either is missing.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";
import { getAccessibleDepartmentSummaries } from "@/lib/services/department-scope-service";
import { createSubDepartment } from "@/lib/services/sub-department-service";

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

  let deptA: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let deptB: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let subA: Awaited<ReturnType<typeof createSubDepartment>> | undefined;
  let subB: Awaited<ReturnType<typeof createSubDepartment>> | undefined;
  let managerA: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let outsider: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const membershipIds: string[] = [];
  const subDeptIds: string[] = [];

  try {
    deptA = await prisma.department.create({ data: { name: `Test Cross Dept A ${RUN_ID}`, slug: `test-cross-dept-a-${RUN_ID}` } });
    deptB = await prisma.department.create({ data: { name: `Test Cross Dept B ${RUN_ID}`, slug: `test-cross-dept-b-${RUN_ID}` } });
    subA = await createSubDepartment({ departmentId: deptA.id, name: `Cross Sub A ${RUN_ID}` });
    subDeptIds.push(subA.id);
    subB = await createSubDepartment({ departmentId: deptB.id, name: `Cross Sub B ${RUN_ID}` });
    subDeptIds.push(subB.id);

    managerA = await prisma.user.create({ data: { email: `test-cross-manager-a-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    outsider = await prisma.user.create({ data: { email: `test-cross-outsider-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });

    const managerAMembership = await prisma.departmentMembership.create({
      data: { userId: managerA.id, departmentId: deptA.id, role: DepartmentRole.DEPARTMENT_MANAGER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(managerAMembership.id);

    console.log("\nTesting a scoped Department Manager's accessible set...\n");
    const managerAAccessible = await getAccessibleDepartmentSummaries(managerA.id, Role.USER, "subdepartment.view");
    check("managerA's accessible set includes deptA", managerAAccessible.some((d) => d.id === deptA!.id));
    check("managerA's accessible set does NOT include deptB", !managerAAccessible.some((d) => d.id === deptB!.id));

    console.log("\nTesting sub-department listing narrows to the accessible set...\n");
    const managerAAccessibleIds = managerAAccessible.map((d) => d.id);
    const visibleToManagerA = await prisma.subDepartment.findMany({ where: { departmentId: { in: managerAAccessibleIds } } });
    check("Only subA is visible to managerA", visibleToManagerA.length === 1 && visibleToManagerA[0].id === subA.id);

    console.log("\nTesting ADMIN's cross-department accessible set...\n");
    const adminAccessible = await getAccessibleDepartmentSummaries("irrelevant-admin-id", Role.ADMIN, "subdepartment.view");
    check("ADMIN's accessible set includes deptA", adminAccessible.some((d) => d.id === deptA!.id));
    check("ADMIN's accessible set includes deptB", adminAccessible.some((d) => d.id === deptB!.id));

    console.log("\nTesting a user with no subdepartment.view anywhere...\n");
    const outsiderAccessible = await getAccessibleDepartmentSummaries(outsider.id, Role.USER, "subdepartment.view");
    check("outsider's accessible set is empty", outsiderAccessible.length === 0);
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      ["subDepartments", () => prisma.subDepartment.deleteMany({ where: { id: { in: subDeptIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: [managerA?.id, outsider?.id].filter((id): id is string => !!id) } } })],
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
