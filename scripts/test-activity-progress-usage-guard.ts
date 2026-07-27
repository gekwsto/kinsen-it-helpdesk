/**
 * Usage-analysis guard for Activity Progress disable/delete
 * (app/api/admin/activity-progress/route.ts's PUT disable-transition check
 * and DELETE handler, both built on lib/activities/activity-progress.ts's
 * countActivitiesUsingStatus). An Activity Progress config row is
 * semantically tied to a specific ActivityStatus — an admin must never be
 * able to disable or delete a row that real activities currently depend on
 * and silently strand them without progress semantics.
 *
 * Tests:
 *  1. countActivitiesUsingStatus reports 0 for a status nothing uses yet.
 *  2. countActivitiesUsingStatus reports the real count once an activity
 *     has that status.
 *  3. The disable transition (isEnabled true -> false) is BLOCKED (mirrors
 *     the PUT route's exact guard condition) while an activity uses the
 *     status — the row's isEnabled must remain unchanged.
 *  4. The delete is BLOCKED (mirrors the DELETE route's exact guard
 *     condition) while an activity uses the status — the row must still
 *     exist afterward.
 *  5. Once the activity is moved to a different status (usage count drops
 *     to 0), the SAME disable and delete are now ALLOWED.
 *  6. A disabled row is never treated as a "missing" row in normal runtime
 *     resolution — it fails via the DISABLED reason specifically (already
 *     covered functionally in test-activity-progress-from-status.ts;
 *     reasserted here in the context of "was this row disabled through the
 *     guarded path").
 *  7. countActivitiesUsingStatus also counts legacy departmentId:null
 *     activities when the department being checked is the app's default
 *     legacy department (same rule getActivityProgressFromStatus itself uses).
 *
 * Usage: npx tsx scripts/test-activity-progress-usage-guard.ts
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, ActivityStatus, ActivityPriority, ProjectStatus, Role } from "@prisma/client";
import { countActivitiesUsingStatus, getActivityProgressFromStatus, ActivityProgressConfigurationError, __resetReportedGapsForTests } from "@/lib/activities/activity-progress";
import { getDefaultLegacyDepartmentId } from "@/lib/services/department-service";

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

/** Mirrors the exact guard condition in the PUT route: block a true->false transition while the status is in use. */
async function attemptDisable(departmentId: string, status: ActivityStatus): Promise<{ blocked: boolean; usageCount: number }> {
  const usageCount = await countActivitiesUsingStatus(departmentId, status);
  if (usageCount > 0) return { blocked: true, usageCount };
  await prisma.activityProgressConfig.update({ where: { departmentId_status: { departmentId, status } }, data: { isEnabled: false } });
  return { blocked: false, usageCount };
}

/** Mirrors the exact guard condition in the DELETE route. */
async function attemptDelete(departmentId: string, status: ActivityStatus): Promise<{ blocked: boolean; usageCount: number }> {
  const usageCount = await countActivitiesUsingStatus(departmentId, status);
  if (usageCount > 0) return { blocked: true, usageCount };
  await prisma.activityProgressConfig.delete({ where: { departmentId_status: { departmentId, status } } });
  return { blocked: false, usageCount };
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

  let dept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let owner: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let project: Awaited<ReturnType<typeof prisma.project.create>> | undefined;
  const activityIds: string[] = [];
  const configIds: string[] = [];

  try {
    dept = await prisma.department.create({ data: { name: `Test Usage Guard Dept ${RUN_ID}`, slug: `test-usage-guard-dept-${RUN_ID}` } });
    owner = await prisma.user.create({ data: { email: `test-usage-guard-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    project = await prisma.project.create({ data: { title: `Test Usage Guard Project ${RUN_ID}`, status: ProjectStatus.IN_PROGRESS, departmentId: dept.id, ownerId: owner.id } });

    const blockedRow = await prisma.activityProgressConfig.create({ data: { departmentId: dept.id, status: ActivityStatus.BLOCKED, progressPercent: 50, sortOrder: 0, isEnabled: true } });
    configIds.push(blockedRow.id);

    console.log("Usage count is 0 before any activity uses the status\n");
    check("countActivitiesUsingStatus(dept, BLOCKED) === 0 with no activities yet", (await countActivitiesUsingStatus(dept.id, ActivityStatus.BLOCKED)) === 0);

    const activity = await prisma.projectActivity.create({
      data: { title: `Test Usage Guard Activity ${RUN_ID}`, status: ActivityStatus.BLOCKED, priority: ActivityPriority.MEDIUM, departmentId: dept.id, projectId: project.id, progress: 50 },
    });
    activityIds.push(activity.id);

    console.log("\nUsage count reflects the real activity once it exists\n");
    check("countActivitiesUsingStatus(dept, BLOCKED) === 1 once one activity has that status", (await countActivitiesUsingStatus(dept.id, ActivityStatus.BLOCKED)) === 1);

    console.log("\nDisable is BLOCKED while the status is in use — row stays enabled\n");
    const disableAttempt1 = await attemptDisable(dept.id, ActivityStatus.BLOCKED);
    check("Disable attempt reports blocked:true with usageCount:1", disableAttempt1.blocked === true && disableAttempt1.usageCount === 1);
    const rowAfterBlockedDisable = await prisma.activityProgressConfig.findUnique({ where: { departmentId_status: { departmentId: dept.id, status: ActivityStatus.BLOCKED } } });
    check("Row's isEnabled is untouched (still true) after a blocked disable attempt", rowAfterBlockedDisable?.isEnabled === true);

    console.log("\nDelete is BLOCKED while the status is in use — row still exists\n");
    const deleteAttempt1 = await attemptDelete(dept.id, ActivityStatus.BLOCKED);
    check("Delete attempt reports blocked:true with usageCount:1", deleteAttempt1.blocked === true && deleteAttempt1.usageCount === 1);
    const rowStillExists = await prisma.activityProgressConfig.findUnique({ where: { departmentId_status: { departmentId: dept.id, status: ActivityStatus.BLOCKED } } });
    check("Row was NOT deleted", rowStillExists != null);

    console.log("\nOnce the activity moves to a different (configured) status, disable/delete become allowed\n");
    const todoRow = await prisma.activityProgressConfig.create({ data: { departmentId: dept.id, status: ActivityStatus.TODO, progressPercent: 0, sortOrder: 1, isEnabled: true } });
    configIds.push(todoRow.id);
    await prisma.projectActivity.update({ where: { id: activity.id }, data: { status: ActivityStatus.TODO, progress: await getActivityProgressFromStatus(dept.id, ActivityStatus.TODO) } });
    check("countActivitiesUsingStatus(dept, BLOCKED) drops to 0 after the activity moved away", (await countActivitiesUsingStatus(dept.id, ActivityStatus.BLOCKED)) === 0);

    const disableAttempt2 = await attemptDisable(dept.id, ActivityStatus.BLOCKED);
    check("Disable is now allowed (blocked:false) once unused", disableAttempt2.blocked === false);
    const rowAfterAllowedDisable = await prisma.activityProgressConfig.findUnique({ where: { departmentId_status: { departmentId: dept.id, status: ActivityStatus.BLOCKED } } });
    check("Row is now actually disabled", rowAfterAllowedDisable?.isEnabled === false);

    // Re-create BLOCKED (still unused) to test delete separately from disable.
    const blockedRow2 = await prisma.activityProgressConfig.create({ data: { departmentId: dept.id, status: ActivityStatus.CANCELLED, progressPercent: 0, sortOrder: 2, isEnabled: true } });
    configIds.push(blockedRow2.id);
    const deleteAttempt2 = await attemptDelete(dept.id, ActivityStatus.CANCELLED);
    check("Delete is allowed (blocked:false) for a status nothing uses", deleteAttempt2.blocked === false);
    const rowAfterAllowedDelete = await prisma.activityProgressConfig.findUnique({ where: { departmentId_status: { departmentId: dept.id, status: ActivityStatus.CANCELLED } } });
    check("Row was actually deleted", rowAfterAllowedDelete === null);

    console.log("\nA disabled row (reached via the guarded path) resolves via the DISABLED reason, never treated as merely 'missing'\n");
    __resetReportedGapsForTests();
    let disabledReason: string | null = null;
    try {
      await getActivityProgressFromStatus(dept.id, ActivityStatus.BLOCKED);
    } catch (err) {
      if (err instanceof ActivityProgressConfigurationError) disabledReason = err.reason;
    }
    check("Resolving the now-disabled BLOCKED status throws with reason:'disabled' (not 'missing')", disabledReason === "disabled");

    console.log("\ncountActivitiesUsingStatus also counts legacy departmentId:null activities for the app's default legacy department\n");
    const legacyDeptId = await getDefaultLegacyDepartmentId();
    if (legacyDeptId) {
      const legacyRow = await prisma.activityProgressConfig.findFirst({ where: { departmentId: legacyDeptId }, select: { status: true } });
      if (legacyRow) {
        const baselineCount = await countActivitiesUsingStatus(legacyDeptId, legacyRow.status);
        const legacyActivity = await prisma.projectActivity.create({
          data: { title: `Test Legacy Usage Guard ${RUN_ID}`, status: legacyRow.status, priority: ActivityPriority.MEDIUM, departmentId: null, projectId: project.id, progress: 0 },
        });
        activityIds.push(legacyActivity.id);
        const afterCount = await countActivitiesUsingStatus(legacyDeptId, legacyRow.status);
        check("A departmentId:null activity is counted against the legacy default department's usage", afterCount === baselineCount + 1);
      } else {
        console.log("  (legacy department has no progress rows in this environment — skipping)");
      }
    } else {
      console.log("  (no default legacy department configured in this environment — skipping)");
    }
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["activities", () => (activityIds.length > 0 ? prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } }) : Promise.resolve())],
      ["project", () => (project ? prisma.project.deleteMany({ where: { id: project.id } }) : Promise.resolve())],
      ["activityProgressConfig", () => (configIds.length > 0 ? prisma.activityProgressConfig.deleteMany({ where: { id: { in: configIds } } }) : Promise.resolve())],
      ["user", () => (owner ? prisma.user.deleteMany({ where: { id: owner.id } }) : Promise.resolve())],
      ["department", () => (dept ? prisma.department.deleteMany({ where: { id: dept.id } }) : Promise.resolve())],
    ];
    for (const [label, step] of cleanupSteps) {
      try {
        await step();
      } catch (err) {
        console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
    __resetReportedGapsForTests();
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
