/**
 * SubDepartment CRUD: a SubDepartment can never exist without a parent
 * Department and can never be reassigned to a different one implicitly.
 * lib/services/sub-department-service.ts is the single place these rules
 * live (createSubDepartment, validateSubDepartmentInDepartment) — reused
 * unchanged by every entity route (ticket/project/activity).
 *
 * Tests:
 *  1. Create a SubDepartment under a Department.
 *  2. Duplicate name in the SAME department is rejected (@@unique([departmentId, name])).
 *  3. The same name under a DIFFERENT department is allowed.
 *  4. Disabling (isActive:false) does not delete the row or its history.
 *  5. validateSubDepartmentInDepartment: true only when the sub-department's
 *     departmentId matches the entity's departmentId; false for a mismatch,
 *     false for a nonexistent id, false when departmentId is null/undefined.
 *
 * Usage: npx tsx scripts/test-subdepartment-crud.ts
 * Requires a reachable DATABASE_URL AND the
 * 20260721100000_add_subdepartments_and_custom_department_roles migration
 * applied — reports clearly and exits if either is missing.
 */
import { prisma } from "@/lib/prisma";
import { createSubDepartment, setSubDepartmentActive, validateSubDepartmentInDepartment } from "@/lib/services/sub-department-service";

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
    await prisma.subDepartment.findFirst({ select: { id: true, isActive: true, slug: true } });
  } catch (err) {
    migrationApplied = false;
    console.log(
      "\nSubDepartment.isActive/slug isn't usable against this database yet (migration " +
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
  const subDeptIds: string[] = [];

  try {
    deptA = await prisma.department.create({ data: { name: `Test SubDept CRUD Dept A ${RUN_ID}`, slug: `test-subdept-crud-a-${RUN_ID}` } });
    deptB = await prisma.department.create({ data: { name: `Test SubDept CRUD Dept B ${RUN_ID}`, slug: `test-subdept-crud-b-${RUN_ID}` } });

    console.log("\nTesting SubDepartment creation...\n");
    const sharedName = `Field Support ${RUN_ID}`;
    const subDeptA = await createSubDepartment({ departmentId: deptA.id, name: sharedName, description: "Test sub-department" });
    subDeptIds.push(subDeptA.id);
    check("Created with the given department", subDeptA.departmentId === deptA.id);
    check("Created active by default", subDeptA.isActive === true);
    check("Auto-slugged", !!subDeptA.slug);

    console.log("\nTesting duplicate-name rejection within the same department...\n");
    let duplicateRejected = false;
    try {
      // Mirrors the route's own pre-check (findFirst by [departmentId, name])
      // followed by the DB-level @@unique backstop — exercise the DB
      // constraint directly here since createSubDepartment itself has no
      // pre-check (that's the route's job).
      await prisma.subDepartment.create({ data: { departmentId: deptA.id, name: sharedName, slug: "duplicate" } });
    } catch {
      duplicateRejected = true;
    }
    check("Duplicate name in the same department is rejected by the DB constraint", duplicateRejected);

    console.log("\nTesting the same name is allowed under a different department...\n");
    const subDeptB = await createSubDepartment({ departmentId: deptB.id, name: sharedName });
    subDeptIds.push(subDeptB.id);
    check("Same name under a different department succeeds", subDeptB.departmentId === deptB.id);

    console.log("\nTesting disable does not delete...\n");
    const disabled = await setSubDepartmentActive(subDeptA.id, false);
    check("isActive is now false", disabled.isActive === false);
    const stillThere = await prisma.subDepartment.findUnique({ where: { id: subDeptA.id } });
    check("Row still exists after disabling", stillThere !== null);

    console.log("\nTesting validateSubDepartmentInDepartment...\n");
    check("True when subDepartment.departmentId matches the entity's departmentId", await validateSubDepartmentInDepartment(subDeptB.id, deptB.id));
    check("False when the sub-department belongs to a different department", !(await validateSubDepartmentInDepartment(subDeptB.id, deptA.id)));
    check("False for a nonexistent sub-department id", !(await validateSubDepartmentInDepartment("nonexistent-id", deptA.id)));
    check("False when departmentId is null", !(await validateSubDepartmentInDepartment(subDeptB.id, null)));
    check("False when departmentId is undefined", !(await validateSubDepartmentInDepartment(subDeptB.id, undefined)));
  } finally {
    try {
      await prisma.subDepartment.deleteMany({ where: { id: { in: subDeptIds } } });
    } catch (err) {
      console.warn("Cleanup step \"subDepartments\" failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    try {
      await prisma.department.deleteMany({ where: { id: { in: [deptA?.id, deptB?.id].filter((id): id is string => !!id) } } });
    } catch (err) {
      console.warn("Cleanup step \"departments\" failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
