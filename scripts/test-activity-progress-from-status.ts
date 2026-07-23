/**
 * Activity progress is now fully derived from status, per-department
 * configurable (ActivityProgressConfig, see lib/activities/activity-progress.ts)
 * — replacing the old ticket-completion-ratio mechanism entirely. Manual
 * progress is no longer client-settable (removed from
 * createActivitySchema/updateActivitySchema).
 *
 * Tests:
 *  1. A department with no ActivityProgressConfig rows falls back to
 *     DEFAULT_STATUS_PROGRESS for every status.
 *  2. A department's own custom percentage overrides the default once set,
 *     merged over the defaults (a department can override just one status
 *     and still get sensible defaults for the rest).
 *  3. getProgressConfigsForDepartments (bulk loader) + resolveProgress agree
 *     with the single-activity getActivityProgressFromStatus for the same
 *     department/status.
 *  4. Creating an activity via the real POST-equivalent write path (direct
 *     prisma.create mirroring app/api/activities/route.ts) sets progress
 *     from the department's config at creation time.
 *  5. Changing an activity's status (mirroring the PATCH route) always
 *     recomputes progress from the new status and the department's current
 *     config — never a manually-supplied value.
 *  6. Mark Complete (isCompleted:true, status:COMPLETED) yields the
 *     department's configured COMPLETED percentage (100 by default).
 *  7. recalculateProjectRollup averages a project's activities' (now always
 *     status-derived) progress values correctly.
 *
 * Usage: npx tsx scripts/test-activity-progress-from-status.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, ActivityStatus, ActivityPriority, ProjectStatus, Role } from "@prisma/client";
import {
  DEFAULT_STATUS_PROGRESS,
  getDepartmentProgressConfig,
  getActivityProgressFromStatus,
  getProgressConfigsForDepartments,
  resolveProgress,
} from "@/lib/activities/activity-progress";
import { recalculateProjectRollup } from "@/lib/projects/progress-rollup";

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

  let dept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let owner: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let project: Awaited<ReturnType<typeof prisma.project.create>> | undefined;
  const activityIds: string[] = [];
  const configIds: string[] = [];

  try {
    dept = await prisma.department.create({ data: { name: `Test Progress Dept ${RUN_ID}`, slug: `test-progress-dept-${RUN_ID}` } });
    owner = await prisma.user.create({ data: { email: `test-progress-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });

    console.log("Fallback to defaults when no config rows exist\n");
    const emptyConfig = await getDepartmentProgressConfig(dept.id);
    for (const status of Object.keys(DEFAULT_STATUS_PROGRESS) as ActivityStatus[]) {
      check(`${status} falls back to default (${DEFAULT_STATUS_PROGRESS[status]}%)`, emptyConfig[status] === DEFAULT_STATUS_PROGRESS[status]);
    }

    console.log("\nA custom percentage overrides the default, others stay default\n");
    const customConfig = await prisma.activityProgressConfig.create({
      data: { departmentId: dept.id, status: ActivityStatus.IN_PROGRESS, progressPercent: 70 },
    });
    configIds.push(customConfig.id);
    const mergedConfig = await getDepartmentProgressConfig(dept.id);
    check("IN_PROGRESS uses the custom 70% override", mergedConfig.IN_PROGRESS === 70);
    check("TODO still falls back to the default (0%)", mergedConfig.TODO === DEFAULT_STATUS_PROGRESS.TODO);
    check("getActivityProgressFromStatus agrees (IN_PROGRESS -> 70)", (await getActivityProgressFromStatus(dept.id, ActivityStatus.IN_PROGRESS)) === 70);

    console.log("\nBulk loader (getProgressConfigsForDepartments) agrees with the single-activity helper\n");
    const bulkConfigs = await getProgressConfigsForDepartments([dept.id]);
    check("resolveProgress(bulk, dept, IN_PROGRESS) === 70", resolveProgress(bulkConfigs, dept.id, ActivityStatus.IN_PROGRESS) === 70);
    check("resolveProgress(bulk, dept, TODO) === default", resolveProgress(bulkConfigs, dept.id, ActivityStatus.TODO) === DEFAULT_STATUS_PROGRESS.TODO);
    check("resolveProgress falls back to defaults for a department not in the bulk map", resolveProgress(bulkConfigs, "not-a-real-dept-id", ActivityStatus.COMPLETED) === DEFAULT_STATUS_PROGRESS.COMPLETED);
    check("resolveProgress falls back to defaults for a null departmentId", resolveProgress(bulkConfigs, null, ActivityStatus.BLOCKED) === DEFAULT_STATUS_PROGRESS.BLOCKED);

    console.log("\nCreating an activity sets progress from the department's config at creation time (mirrors POST /api/activities)\n");
    project = await prisma.project.create({ data: { title: `Test Progress Project ${RUN_ID}`, status: ProjectStatus.IN_PROGRESS, departmentId: dept.id, ownerId: owner.id } });
    const created = await prisma.projectActivity.create({
      data: {
        title: `Test Progress Activity ${RUN_ID}`,
        status: ActivityStatus.IN_PROGRESS,
        priority: ActivityPriority.MEDIUM,
        departmentId: dept.id,
        projectId: project.id,
        progress: await getActivityProgressFromStatus(dept.id, ActivityStatus.IN_PROGRESS),
      },
    });
    activityIds.push(created.id);
    check("New IN_PROGRESS activity gets the department's custom 70%, not the hardcoded default", created.progress === 70);

    console.log("\nChanging status always recomputes progress from the new status (mirrors PATCH /api/activities/[id])\n");
    const movedToTodo = await prisma.projectActivity.update({
      where: { id: created.id },
      data: { status: ActivityStatus.TODO, progress: await getActivityProgressFromStatus(dept.id, ActivityStatus.TODO) },
    });
    check("Moving to TODO recomputes progress to 0%", movedToTodo.progress === 0);

    console.log("\nMark Complete yields the department's configured COMPLETED percentage\n");
    const completed = await prisma.projectActivity.update({
      where: { id: created.id },
      data: {
        isCompleted: true,
        status: ActivityStatus.COMPLETED,
        completedAt: new Date(),
        progress: await getActivityProgressFromStatus(dept.id, ActivityStatus.COMPLETED),
      },
    });
    check("Mark Complete sets progress to 100% (this department never overrode COMPLETED)", completed.progress === 100);

    console.log("\nrecalculateProjectRollup averages a project's activities' progress\n");
    const secondActivity = await prisma.projectActivity.create({
      data: {
        title: `Test Progress Activity 2 ${RUN_ID}`,
        status: ActivityStatus.TODO,
        priority: ActivityPriority.MEDIUM,
        departmentId: dept.id,
        projectId: project.id,
        progress: 0,
      },
    });
    activityIds.push(secondActivity.id);
    // Two activities: 100% (completed above) and 0% -> average 50%.
    await recalculateProjectRollup(project.id);
    const projectAfterRollup = await prisma.project.findUnique({ where: { id: project.id }, select: { progress: true } });
    check("Project progress is the average of its activities' progress (100 + 0) / 2 = 50", projectAfterRollup?.progress === 50);
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
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
