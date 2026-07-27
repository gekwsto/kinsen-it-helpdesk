/**
 * Full CRUD + reorder for department-scoped Activity Progress config, and
 * the safety rules around it (lib/activities/activity-progress.ts +
 * app/api/admin/activity-progress/route.ts):
 *  1. Duplicate (departmentId, status) is rejected at the DB level (unique
 *     constraint) — mirrors the API's own pre-check + P2002 handling.
 *  2. The SAME status can have separate rows in two different departments
 *     (no global uniqueness).
 *  3. Percentage validation: 0 and 100 are valid boundary values; -1 and 101
 *     are invalid (mirrors the API route's isValidPercent).
 *  4. Create ("add back" a status), edit (percent/isEnabled), delete, and
 *     reorder (sortOrder swap) all work via direct row manipulation
 *     mirroring the API's own logic.
 *  5. getDepartmentProgressRows only returns a department's OWN rows, sorted
 *     by sortOrder, and reflects a delete (fewer than the full set).
 *  6. A delete only removes that one department's row — a same-named status
 *     in another department is untouched (no cross-department leakage).
 *
 * Usage: npx tsx scripts/test-activity-progress-admin-crud.ts
 */
import { prisma } from "@/lib/prisma";
import { ActivityStatus } from "@prisma/client";
import { getDepartmentProgressRows } from "@/lib/activities/activity-progress";

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

function isValidPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
}

const RUN_ID = Date.now();

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  let deptA: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let deptB: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  const configIds: string[] = [];

  try {
    deptA = await prisma.department.create({ data: { name: `Test CRUD Dept A ${RUN_ID}`, slug: `test-crud-dept-a-${RUN_ID}` } });
    deptB = await prisma.department.create({ data: { name: `Test CRUD Dept B ${RUN_ID}`, slug: `test-crud-dept-b-${RUN_ID}` } });

    console.log("Percentage validation (mirrors the API's isValidPercent)\n");
    check("0 is valid", isValidPercent(0));
    check("100 is valid", isValidPercent(100));
    check("-1 is invalid", !isValidPercent(-1));
    check("101 is invalid", !isValidPercent(101));
    check("50.5 (non-integer) is invalid", !isValidPercent(50.5));
    check("'50' (string) is invalid", !isValidPercent("50"));

    console.log("\nCreate: a status can be added for a department that doesn't have it yet\n");
    const rowA = await prisma.activityProgressConfig.create({ data: { departmentId: deptA.id, status: ActivityStatus.TODO, progressPercent: 5, sortOrder: 0 } });
    configIds.push(rowA.id);
    check("Row created with the requested percentage", rowA.progressPercent === 5);
    check("New row defaults to enabled", rowA.isEnabled === true);

    console.log("\nDuplicate (departmentId, status) is rejected by the unique constraint\n");
    let duplicateRejected = false;
    try {
      await prisma.activityProgressConfig.create({ data: { departmentId: deptA.id, status: ActivityStatus.TODO, progressPercent: 20, sortOrder: 1 } });
    } catch (err: any) {
      duplicateRejected = err.code === "P2002";
    }
    check("Creating a second TODO row for the same department throws P2002", duplicateRejected);

    console.log("\nThe SAME status in a DIFFERENT department is allowed (no global uniqueness)\n");
    const rowB = await prisma.activityProgressConfig.create({ data: { departmentId: deptB.id, status: ActivityStatus.TODO, progressPercent: 20, sortOrder: 0 } });
    configIds.push(rowB.id);
    check("Dept B's TODO row was created independently of Dept A's", rowB.progressPercent === 20);

    console.log("\nEdit: percent and isEnabled update in place\n");
    const edited = await prisma.activityProgressConfig.update({ where: { id: rowA.id }, data: { progressPercent: 15, isEnabled: false } });
    check("Percent updated to 15", edited.progressPercent === 15);
    check("isEnabled updated to false", edited.isEnabled === false);
    await prisma.activityProgressConfig.update({ where: { id: rowA.id }, data: { isEnabled: true } });

    console.log("\nReorder: sortOrder values can be swapped between two rows in the same department\n");
    const rowA2 = await prisma.activityProgressConfig.create({ data: { departmentId: deptA.id, status: ActivityStatus.IN_PROGRESS, progressPercent: 50, sortOrder: 1 } });
    configIds.push(rowA2.id);
    await prisma.$transaction([
      prisma.activityProgressConfig.update({ where: { id: rowA.id }, data: { sortOrder: 1 } }),
      prisma.activityProgressConfig.update({ where: { id: rowA2.id }, data: { sortOrder: 0 } }),
    ]);
    const reorderedRows = await getDepartmentProgressRows(deptA.id);
    check("After reorder, IN_PROGRESS (sortOrder 0) comes first", reorderedRows[0]?.status === ActivityStatus.IN_PROGRESS);
    check("After reorder, TODO (sortOrder 1) comes second", reorderedRows[1]?.status === ActivityStatus.TODO);

    console.log("\ngetDepartmentProgressRows returns only that department's own rows\n");
    const deptARows = await getDepartmentProgressRows(deptA.id);
    const deptBRows = await getDepartmentProgressRows(deptB.id);
    check("Dept A has exactly its own 2 rows", deptARows.length === 2);
    check("Dept B has exactly its own 1 row", deptBRows.length === 1);
    check("Dept B's rows never include Dept A's IN_PROGRESS row", !deptBRows.some((r) => r.status === ActivityStatus.IN_PROGRESS));

    console.log("\nDelete: removes only that department's row for that status, leaving other departments untouched\n");
    await prisma.activityProgressConfig.delete({ where: { id: rowA.id } });
    configIds.splice(configIds.indexOf(rowA.id), 1);
    const deptARowsAfterDelete = await getDepartmentProgressRows(deptA.id);
    const deptBRowsAfterDelete = await getDepartmentProgressRows(deptB.id);
    check("Dept A's TODO row is gone", !deptARowsAfterDelete.some((r) => r.status === ActivityStatus.TODO));
    check("Dept A still has its IN_PROGRESS row", deptARowsAfterDelete.some((r) => r.status === ActivityStatus.IN_PROGRESS));
    check("Dept B's TODO row is untouched by Dept A's delete (no cross-department leakage)", deptBRowsAfterDelete.some((r) => r.status === ActivityStatus.TODO && r.progressPercent === 20));
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["activityProgressConfig", () => (configIds.length > 0 ? prisma.activityProgressConfig.deleteMany({ where: { id: { in: configIds } } }) : Promise.resolve())],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: [deptA?.id, deptB?.id].filter((x): x is string => !!x) } } })],
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
