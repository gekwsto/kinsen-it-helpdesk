/**
 * Department-scoped Activity Status management (label/color/sortOrder/
 * isEnabled/isTerminal) — extends the EXISTING ActivityStatusConfig table
 * (never a second/parallel config system; the same table
 * lib/status-terminal.ts's isTerminal resolution already used).
 *
 * Uses the user's own example: IT {TODO -> "To Do"}, Sales {TODO -> "New
 * Activity"}.
 *
 * Tests:
 *  1. IT and Sales each get their own full starter row set (label/color/
 *     sortOrder/isEnabled/isTerminal) — created via createDepartment(), the
 *     same ensure-function seed.ts uses (never duplicated logic).
 *  2. Renaming IT's TODO label does not affect Sales' TODO label (or vice
 *     versa) — proven by literal row equality checks after the edit.
 *  3. Changing IT's color/sortOrder does not affect Sales.
 *  4. The Activity Progress percentage for a given department+status stays
 *     correctly linked regardless of label changes (same status key, same
 *     ActivityProgressConfig row — editing the label never touches
 *     progressPercent).
 *  5. Disabling a status removes it from getEnabledActivityStatusesForDepartment
 *     (what a "new activity" dropdown offers) — but resolveActivityStatusDisplay
 *     still returns its real historical label/color for an existing activity
 *     already on that status (never hidden, never a hardcoded fallback).
 *  6. An activity created with a status BEFORE it's disabled keeps reading
 *     that status's real label/color afterward.
 *  7. Delete is blocked (usage-analysis guard, reusing the same
 *     countActivitiesUsingStatus as Activity Progress) while an activity
 *     uses the status; allowed once unused.
 *  8. Terminal-status resolution (lib/status-terminal.ts's isActivityStatusTerminal)
 *     reads the SAME ActivityStatusConfig row this admin UI edits — no
 *     second mechanism — proven by editing isTerminal here and observing
 *     the terminal resolver agree immediately.
 *  9. A new department created via createDepartment() gets independent
 *     starter rows — editing it never touches IT/Sales.
 *
 * Usage: npx tsx scripts/test-activity-status-department-isolation.ts
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, ActivityStatus, ActivityPriority, ProjectStatus, Role } from "@prisma/client";
import {
  getDepartmentActivityStatusRows,
  getEnabledActivityStatusesForDepartment,
  getActivityStatusDisplayConfigsForDepartments,
  resolveActivityStatusDisplay,
} from "@/lib/services/activity-status-config";
import { countActivitiesUsingStatus, getActivityProgressFromStatus } from "@/lib/activities/activity-progress";
import { isActivityStatusTerminal } from "@/lib/status-terminal";
import { createDepartment } from "@/lib/services/department-service";

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

const RUN_ID = Date.now();

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  let itDept: Awaited<ReturnType<typeof createDepartment>> | undefined;
  let salesDept: Awaited<ReturnType<typeof createDepartment>> | undefined;
  let newDept: Awaited<ReturnType<typeof createDepartment>> | undefined;
  let owner: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let project: Awaited<ReturnType<typeof prisma.project.create>> | undefined;
  const activityIds: string[] = [];

  try {
    console.log("Test 1: IT and Sales each get a full independent starter row set via createDepartment()\n");
    itDept = await createDepartment({ name: `Test IT Status Isolation ${RUN_ID}` });
    salesDept = await createDepartment({ name: `Test Sales Status Isolation ${RUN_ID}` });
    const itRows = await getDepartmentActivityStatusRows(itDept.id);
    const salesRows = await getDepartmentActivityStatusRows(salesDept.id);
    check("IT has all 6 starter rows", itRows.length === 6);
    check("Sales has all 6 starter rows", salesRows.length === 6);
    check("IT's starter TODO label is 'To Do' (matches the previous app-wide default)", itRows.find((r) => r.status === "TODO")?.label === "To Do");

    console.log("\nTest 2: Renaming IT's TODO to 'To Do' (unchanged) and Sales' TODO to 'New Activity' — independent\n");
    await prisma.activityStatusConfig.update({ where: { departmentId_status: { departmentId: salesDept.id, status: ActivityStatus.TODO } }, data: { label: "New Activity" } });
    const itTodoAfter = await prisma.activityStatusConfig.findUniqueOrThrow({ where: { departmentId_status: { departmentId: itDept.id, status: ActivityStatus.TODO } } });
    const salesTodoAfter = await prisma.activityStatusConfig.findUniqueOrThrow({ where: { departmentId_status: { departmentId: salesDept.id, status: ActivityStatus.TODO } } });
    check("IT's TODO label is STILL 'To Do' — Sales' rename did not leak into IT", itTodoAfter.label === "To Do");
    check("Sales' TODO label actually became 'New Activity'", salesTodoAfter.label === "New Activity");

    console.log("\nTest 3: Changing IT's color/sortOrder does not affect Sales\n");
    await prisma.activityStatusConfig.update({ where: { departmentId_status: { departmentId: itDept.id, status: ActivityStatus.IN_PROGRESS } }, data: { color: "#123456", sortOrder: 9 } });
    const salesInProgress = await prisma.activityStatusConfig.findUniqueOrThrow({ where: { departmentId_status: { departmentId: salesDept.id, status: ActivityStatus.IN_PROGRESS } } });
    check("Sales' IN_PROGRESS color/sortOrder are untouched by IT's edit", salesInProgress.color !== "#123456" && salesInProgress.sortOrder !== 9);

    console.log("\nTest 4: Activity Progress percentage stays correctly linked to the SAME (department, status) key regardless of label changes\n");
    const itTodoProgressBefore = await getActivityProgressFromStatus(itDept.id, ActivityStatus.TODO);
    await prisma.activityStatusConfig.update({ where: { departmentId_status: { departmentId: itDept.id, status: ActivityStatus.TODO } }, data: { label: "Renamed Todo" } });
    const itTodoProgressAfter = await getActivityProgressFromStatus(itDept.id, ActivityStatus.TODO);
    check("Renaming the label does not change the linked progress percentage", itTodoProgressBefore === itTodoProgressAfter);

    console.log("\nTest 5-6: Disabling a status removes it from 'new activity' options but existing activities keep reading its real historical label/color\n");
    owner = await prisma.user.create({ data: { email: `test-status-iso-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    project = await prisma.project.create({ data: { title: `Test Status Iso Project ${RUN_ID}`, status: ProjectStatus.IN_PROGRESS, departmentId: itDept.id, ownerId: owner.id } });
    const blockedActivity = await prisma.projectActivity.create({
      data: { title: `Test BLOCKED Activity ${RUN_ID}`, status: ActivityStatus.BLOCKED, priority: ActivityPriority.MEDIUM, departmentId: itDept.id, projectId: project.id, progress: await getActivityProgressFromStatus(itDept.id, ActivityStatus.BLOCKED) },
    });
    activityIds.push(blockedActivity.id);

    const enabledBefore = await getEnabledActivityStatusesForDepartment(itDept.id);
    check("BLOCKED is offered before disabling", enabledBefore.some((r) => r.status === "BLOCKED"));

    // Direct row mutation here (mirrors what the guarded PATCH route would
    // do AFTER its own usage-analysis check passes) — used further down to
    // prove the DISPLAY resolver still reads it correctly; the actual
    // guard behavior is proven separately in test 7 below via the shared
    // countActivitiesUsingStatus function the route itself calls.
    const blockedRowLabel = (await prisma.activityStatusConfig.findUniqueOrThrow({ where: { departmentId_status: { departmentId: itDept.id, status: ActivityStatus.BLOCKED } } })).label;
    await prisma.activityStatusConfig.update({ where: { departmentId_status: { departmentId: itDept.id, status: ActivityStatus.BLOCKED } }, data: { isEnabled: false } });

    const enabledAfter = await getEnabledActivityStatusesForDepartment(itDept.id);
    check("BLOCKED is NOT offered for new activities after disabling", !enabledAfter.some((r) => r.status === "BLOCKED"));

    const displayConfigs = await getActivityStatusDisplayConfigsForDepartments([itDept.id]);
    const blockedDisplay = resolveActivityStatusDisplay(displayConfigs, itDept.id, ActivityStatus.BLOCKED);
    check("The existing BLOCKED activity's status still resolves its REAL historical label (never hidden/hardcoded)", blockedDisplay.label === blockedRowLabel);
    check("resolveActivityStatusDisplay's isEnabled correctly reports false (disabled) without hiding label/color", blockedDisplay.isEnabled === false);

    // Restore for the delete-guard test below.
    await prisma.activityStatusConfig.update({ where: { departmentId_status: { departmentId: itDept.id, status: ActivityStatus.BLOCKED } }, data: { isEnabled: true } });

    console.log("\nTest 7: Delete is blocked while an activity uses the status (usage-analysis guard, shared with Activity Progress); allowed once unused\n");
    const usageCount = await countActivitiesUsingStatus(itDept.id, ActivityStatus.BLOCKED);
    check("countActivitiesUsingStatus correctly finds the 1 BLOCKED activity", usageCount === 1);
    check("Delete would be blocked (mirrors the route's own guard condition)", usageCount > 0);

    await prisma.projectActivity.update({ where: { id: blockedActivity.id }, data: { status: ActivityStatus.TODO, progress: await getActivityProgressFromStatus(itDept.id, ActivityStatus.TODO) } });
    const usageCountAfterMove = await countActivitiesUsingStatus(itDept.id, ActivityStatus.BLOCKED);
    check("Usage count drops to 0 once the activity moves away", usageCountAfterMove === 0);
    await prisma.activityStatusConfig.delete({ where: { departmentId_status: { departmentId: itDept.id, status: ActivityStatus.BLOCKED } } });
    const rowsAfterDelete = await getDepartmentActivityStatusRows(itDept.id);
    check("BLOCKED row was actually deleted now that it's unused", !rowsAfterDelete.some((r) => r.status === "BLOCKED"));

    console.log("\nTest 8: Terminal resolution reads the SAME ActivityStatusConfig row this admin UI edits — no second mechanism\n");
    const completedTerminalBefore = await isActivityStatusTerminal(itDept.id, ActivityStatus.COMPLETED);
    check("COMPLETED starts terminal (starter default)", completedTerminalBefore === true);
    await prisma.activityStatusConfig.update({ where: { departmentId_status: { departmentId: itDept.id, status: ActivityStatus.COMPLETED } }, data: { isTerminal: false } });
    const completedTerminalAfter = await isActivityStatusTerminal(itDept.id, ActivityStatus.COMPLETED);
    check("Editing isTerminal via the SAME row the admin UI writes is immediately reflected by the terminal resolver", completedTerminalAfter === false);
    await prisma.activityStatusConfig.update({ where: { departmentId_status: { departmentId: itDept.id, status: ActivityStatus.COMPLETED } }, data: { isTerminal: true } });

    console.log("\nTest 9: A new department gets independent starter rows — editing it never touches IT/Sales\n");
    newDept = await createDepartment({ name: `Test New Dept Status Isolation ${RUN_ID}` });
    const newDeptRows = await getDepartmentActivityStatusRows(newDept.id);
    check("New department has its own full starter row set", newDeptRows.length === 6);
    await prisma.activityStatusConfig.update({ where: { departmentId_status: { departmentId: newDept.id, status: ActivityStatus.TODO } }, data: { label: "Brand New Label" } });
    const itTodoFinal = await prisma.activityStatusConfig.findUniqueOrThrow({ where: { departmentId_status: { departmentId: itDept.id, status: ActivityStatus.TODO } } });
    const salesTodoFinal = await prisma.activityStatusConfig.findUniqueOrThrow({ where: { departmentId_status: { departmentId: salesDept.id, status: ActivityStatus.TODO } } });
    check("IT's TODO label is untouched by the new department's edit", itTodoFinal.label === "Renamed Todo");
    check("Sales' TODO label is untouched by the new department's edit", salesTodoFinal.label === "New Activity");
  } finally {
    const allDeptIds = [itDept?.id, salesDept?.id, newDept?.id].filter((x): x is string => !!x);
    const priorityIds = allDeptIds.length > 0 ? (await prisma.ticketPriority.findMany({ where: { departmentId: { in: allDeptIds } }, select: { id: true } })).map((p) => p.id) : [];
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["activities", () => (activityIds.length > 0 ? prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } }) : Promise.resolve())],
      ["project", () => (project ? prisma.project.deleteMany({ where: { id: project.id } }) : Promise.resolve())],
      ["user", () => (owner ? prisma.user.deleteMany({ where: { id: owner.id } }) : Promise.resolve())],
      ["priorities", () => (priorityIds.length > 0 ? prisma.ticketPriority.deleteMany({ where: { id: { in: priorityIds } } }) : Promise.resolve())],
      // Every department here was made via createDepartment(), which also
      // creates starter TicketStatus rows (onDelete: RESTRICT on
      // Department) — must be cleared first or the deletion below silently
      // fails, leaking every department in this batch.
      ["statuses", () => (allDeptIds.length > 0 ? prisma.ticketStatus.deleteMany({ where: { departmentId: { in: allDeptIds } } }) : Promise.resolve())],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: allDeptIds } } })],
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
