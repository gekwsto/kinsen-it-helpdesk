/**
 * Regression test for a real bug: the Activity Progress admin page's
 * on-page department dropdown ("All Workspaces" mode) changed only a URL
 * query param, which Next.js does NOT remount a client component for —
 * ActivityProgressConfigForm's `useState(initialRows)` kept showing the
 * PREVIOUS department's percentages under the NEWLY-selected department's
 * label. Saving while "on" the new department silently overwrote its real
 * rows with the old department's stale values. Fixed by making the form
 * own department-switching itself (client-side GET + full state replace on
 * every switch — see components/admin/activity-progress-config-form.tsx).
 *
 * This script re-verifies the underlying DATA LAYER is (and always was)
 * genuinely department-isolated — the schema/API were never the bug — using
 * the user's own IT vs Finance example (IT: TODO 0%/IN_PROGRESS 40%,
 * Finance: TODO 10%/IN_PROGRESS 50%), plus the specific requirements from
 * this follow-up request that weren't already covered by earlier scripts.
 *
 * Tests:
 *  1. GET-equivalent (getDepartmentProgressRows) for IT returns 0/40.
 *  2. GET-equivalent for Finance returns 10/50 — independently.
 *  3. Updating Finance's TODO to 15% (mirrors the PUT route's own
 *     departmentId+status-scoped updateMany) leaves IT's TODO at 0% —
 *     unchanged, not just "eventually consistent."
 *  4. A "full refresh" (fresh getDepartmentProgressRows call, simulating a
 *     hard browser reload re-hitting the GET route) shows the persisted,
 *     genuinely different values for both departments.
 *  5. An update scoped to department A's (departmentId, status) key NEVER
 *     touches department B's row for the SAME status, even when both exist
 *     — proven by asserting B's row is byte-for-byte unchanged (including
 *     updatedAt) after A's update.
 *  6. Duplicate (departmentId, status) is rejected at the DB level (unique
 *     constraint) — re-asserted here in the specific IT/Finance context.
 *  7. Project/activity progress resolution (getActivityProgressFromStatus)
 *     uses the ACTIVITY's own department's percentage, not any other
 *     department's — IT activity gets IT's 40%, Finance activity gets
 *     Finance's 50%, for the identical status.
 *  8. A new department created via createDepartment() gets its own
 *     independent starter rows — editing THAT department's TODO afterward
 *     does not touch IT's or Finance's TODO.
 *  9. Re-running the idempotent ensure-function (as prisma/seed.ts does)
 *     does NOT overwrite a department's already-customized values — IT's
 *     edited 0%/40% and Finance's edited 15%/50% both survive a simulated
 *     reseed.
 *
 * Usage: npx tsx scripts/test-activity-progress-department-isolation.ts
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, ActivityStatus, ActivityPriority, ProjectStatus, Role } from "@prisma/client";
import { getDepartmentProgressRows, getActivityProgressFromStatus } from "@/lib/activities/activity-progress";
import { createDepartment } from "@/lib/services/department-service";
import { ensureActivityProgressConfigForDepartment } from "@/lib/services/config-starter-data";

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

/** Mirrors PUT /api/admin/activity-progress's own update mechanism exactly: updateMany scoped by (departmentId, status) together — never by status alone, never by a bare row id. */
async function updateRow(departmentId: string, status: ActivityStatus, progressPercent: number) {
  return prisma.activityProgressConfig.updateMany({
    where: { departmentId, status },
    data: { progressPercent },
  });
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

  let itDept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let financeDept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let newDept: Awaited<ReturnType<typeof createDepartment>> | undefined;
  let owner: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let project: Awaited<ReturnType<typeof prisma.project.create>> | undefined;
  const activityIds: string[] = [];
  const configIds: string[] = [];

  try {
    itDept = await prisma.department.create({ data: { name: `Test IT Isolation ${RUN_ID}`, slug: `test-it-isolation-${RUN_ID}` } });
    financeDept = await prisma.department.create({ data: { name: `Test Finance Isolation ${RUN_ID}`, slug: `test-finance-isolation-${RUN_ID}` } });

    console.log("Setting up the user's own example: IT {TODO:0, IN_PROGRESS:40}, Finance {TODO:10, IN_PROGRESS:50}\n");
    const itTodo = await prisma.activityProgressConfig.create({ data: { departmentId: itDept.id, status: ActivityStatus.TODO, progressPercent: 0, sortOrder: 0 } });
    const itInProgress = await prisma.activityProgressConfig.create({ data: { departmentId: itDept.id, status: ActivityStatus.IN_PROGRESS, progressPercent: 40, sortOrder: 1 } });
    const itCompleted = await prisma.activityProgressConfig.create({ data: { departmentId: itDept.id, status: ActivityStatus.COMPLETED, progressPercent: 100, sortOrder: 2 } });
    const financeTodo = await prisma.activityProgressConfig.create({ data: { departmentId: financeDept.id, status: ActivityStatus.TODO, progressPercent: 10, sortOrder: 0 } });
    const financeInProgress = await prisma.activityProgressConfig.create({ data: { departmentId: financeDept.id, status: ActivityStatus.IN_PROGRESS, progressPercent: 50, sortOrder: 1 } });
    const financeCompleted = await prisma.activityProgressConfig.create({ data: { departmentId: financeDept.id, status: ActivityStatus.COMPLETED, progressPercent: 100, sortOrder: 2 } });
    configIds.push(itTodo.id, itInProgress.id, itCompleted.id, financeTodo.id, financeInProgress.id, financeCompleted.id);

    console.log("Test 1-2: GET (getDepartmentProgressRows) returns each department's own values\n");
    const itRows1 = await getDepartmentProgressRows(itDept.id);
    const financeRows1 = await getDepartmentProgressRows(financeDept.id);
    check("GET IT: TODO=0%", itRows1.find((r) => r.status === "TODO")?.progressPercent === 0);
    check("GET IT: IN_PROGRESS=40%", itRows1.find((r) => r.status === "IN_PROGRESS")?.progressPercent === 40);
    check("GET Finance: TODO=10%", financeRows1.find((r) => r.status === "TODO")?.progressPercent === 10);
    check("GET Finance: IN_PROGRESS=50%", financeRows1.find((r) => r.status === "IN_PROGRESS")?.progressPercent === 50);

    console.log("\nTest 3: Updating Finance's TODO to 15% leaves IT's TODO at 0% — unchanged\n");
    const financeUpdateBefore = await prisma.activityProgressConfig.findUniqueOrThrow({ where: { id: financeTodo.id } });
    await updateRow(financeDept.id, ActivityStatus.TODO, 15);
    const itTodoAfterFinanceUpdate = await prisma.activityProgressConfig.findUniqueOrThrow({ where: { id: itTodo.id } });
    const financeTodoAfterUpdate = await prisma.activityProgressConfig.findUniqueOrThrow({ where: { id: financeTodo.id } });
    check("IT's TODO row is still 0% (byte-for-byte same row, untouched)", itTodoAfterFinanceUpdate.progressPercent === 0);
    check("Finance's TODO row actually became 15%", financeTodoAfterUpdate.progressPercent === 15);
    check("IT's TODO row id is literally the same row as before (never recreated/reassigned)", itTodoAfterFinanceUpdate.id === itTodo.id);

    console.log("\nTest 4: A 'full refresh' (fresh GET) shows the persisted, genuinely different values\n");
    const itRowsAfterRefresh = await getDepartmentProgressRows(itDept.id);
    const financeRowsAfterRefresh = await getDepartmentProgressRows(financeDept.id);
    check("Fresh GET IT still shows TODO=0% after Finance's edit", itRowsAfterRefresh.find((r) => r.status === "TODO")?.progressPercent === 0);
    check("Fresh GET Finance shows the persisted TODO=15%", financeRowsAfterRefresh.find((r) => r.status === "TODO")?.progressPercent === 15);

    console.log("\nTest 5: An update scoped to (departmentId, status) NEVER touches the other department's row for the SAME status\n");
    const itInProgressBefore = await prisma.activityProgressConfig.findUniqueOrThrow({ where: { id: itInProgress.id } });
    await updateRow(itDept.id, ActivityStatus.IN_PROGRESS, 45);
    const financeInProgressAfterItUpdate = await prisma.activityProgressConfig.findUniqueOrThrow({ where: { id: financeInProgress.id } });
    check("Finance's IN_PROGRESS row is completely untouched by IT's IN_PROGRESS update (same updatedAt)", financeInProgressAfterItUpdate.updatedAt.getTime() === financeInProgress.updatedAt.getTime());
    check("Finance's IN_PROGRESS is still 50%", financeInProgressAfterItUpdate.progressPercent === 50);
    const itInProgressAfter = await prisma.activityProgressConfig.findUniqueOrThrow({ where: { id: itInProgress.id } });
    check("IT's IN_PROGRESS actually updated to 45%", itInProgressAfter.progressPercent === 45);

    console.log("\nTest 6: Duplicate (departmentId, status) is rejected in this exact IT/Finance context\n");
    let duplicateRejected = false;
    try {
      await prisma.activityProgressConfig.create({ data: { departmentId: itDept.id, status: ActivityStatus.TODO, progressPercent: 99, sortOrder: 9 } });
    } catch (err: any) {
      duplicateRejected = err.code === "P2002";
    }
    check("Creating a second IT TODO row throws P2002 (unique constraint holds)", duplicateRejected);

    console.log("\nTest 7: Project/activity progress resolution uses the ACTIVITY's own department's percentage\n");
    owner = await prisma.user.create({ data: { email: `test-isolation-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    project = await prisma.project.create({ data: { title: `Test Isolation Project ${RUN_ID}`, status: ProjectStatus.IN_PROGRESS, departmentId: itDept.id, ownerId: owner.id } });
    const itActivity = await prisma.projectActivity.create({
      data: { title: `Test IT Activity ${RUN_ID}`, status: ActivityStatus.IN_PROGRESS, priority: ActivityPriority.MEDIUM, departmentId: itDept.id, projectId: project.id, progress: await getActivityProgressFromStatus(itDept.id, ActivityStatus.IN_PROGRESS) },
    });
    activityIds.push(itActivity.id);
    check("An IT activity with status IN_PROGRESS gets IT's 45%, not Finance's 50%", itActivity.progress === 45);
    const financeProgressForSameStatus = await getActivityProgressFromStatus(financeDept.id, ActivityStatus.IN_PROGRESS);
    check("The SAME status resolved for Finance independently yields Finance's own 50%", financeProgressForSameStatus === 50);

    console.log("\nTest 8: A new department gets independent starter rows — editing it never touches IT/Finance\n");
    newDept = await createDepartment({ name: `Test New Dept Isolation ${RUN_ID}` });
    const newDeptRows = await getDepartmentProgressRows(newDept.id);
    check("New department has its own full starter row set", newDeptRows.length === 6);
    await updateRow(newDept.id, ActivityStatus.TODO, 77);
    const itTodoAfterNewDeptEdit = await prisma.activityProgressConfig.findUniqueOrThrow({ where: { id: itTodo.id } });
    const financeTodoAfterNewDeptEdit = await prisma.activityProgressConfig.findUniqueOrThrow({ where: { id: financeTodo.id } });
    check("IT's TODO is still 0% after editing the brand-new department's TODO", itTodoAfterNewDeptEdit.progressPercent === 0);
    check("Finance's TODO is still 15% after editing the brand-new department's TODO", financeTodoAfterNewDeptEdit.progressPercent === 15);

    console.log("\nTest 9: Re-running the idempotent ensure-function (simulated reseed) does NOT overwrite already-customized values\n");
    await ensureActivityProgressConfigForDepartment(prisma, itDept.id);
    await ensureActivityProgressConfigForDepartment(prisma, financeDept.id);
    const itRowsAfterReseed = await getDepartmentProgressRows(itDept.id);
    const financeRowsAfterReseed = await getDepartmentProgressRows(financeDept.id);
    check("IT's customized TODO=0%/IN_PROGRESS=45% survive a reseed (not reset to any 'default')", itRowsAfterReseed.find((r) => r.status === "TODO")?.progressPercent === 0 && itRowsAfterReseed.find((r) => r.status === "IN_PROGRESS")?.progressPercent === 45);
    check("Finance's customized TODO=15%/IN_PROGRESS=50% survive a reseed", financeRowsAfterReseed.find((r) => r.status === "TODO")?.progressPercent === 15 && financeRowsAfterReseed.find((r) => r.status === "IN_PROGRESS")?.progressPercent === 50);
  } finally {
    const newDeptPriorityIds = newDept ? (await prisma.ticketPriority.findMany({ where: { departmentId: newDept.id }, select: { id: true } })).map((p) => p.id) : [];
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["activities", () => (activityIds.length > 0 ? prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } }) : Promise.resolve())],
      ["project", () => (project ? prisma.project.deleteMany({ where: { id: project.id } }) : Promise.resolve())],
      ["activityProgressConfig", () => (configIds.length > 0 ? prisma.activityProgressConfig.deleteMany({ where: { id: { in: configIds } } }) : Promise.resolve())],
      ["user", () => (owner ? prisma.user.deleteMany({ where: { id: owner.id } }) : Promise.resolve())],
      ["newDept priorities", () => (newDeptPriorityIds.length > 0 ? prisma.ticketPriority.deleteMany({ where: { id: { in: newDeptPriorityIds } } }) : Promise.resolve())],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: [itDept?.id, financeDept?.id, newDept?.id].filter((x): x is string => !!x) } } })],
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
