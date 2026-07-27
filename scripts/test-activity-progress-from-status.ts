/**
 * Activity progress is derived from status via a per-department,
 * per-status ActivityProgressConfig row (lib/activities/activity-progress.ts).
 * There is NO numeric runtime fallback: a missing or disabled row is a real
 * configuration error.
 *  - WRITE paths (getActivityProgressFromStatus) THROW
 *    ActivityProgressConfigurationError — no number is ever returned on a
 *    gap, so a caller literally cannot accidentally persist a fabricated
 *    percentage; the exception must propagate to a clean request rejection.
 *  - READ paths (resolveProgress) return a discriminated ProgressResolution
 *    (`ok: false` on a gap) — never a bare number standing in for "unknown."
 *
 * Tests:
 *  1. Two departments (IT-like, Sales-like) with DIFFERENT percentages for
 *     the SAME status (TODO) resolve independently — no cross-department leakage.
 *  2. getActivityProgressFromStatus / getProgressConfigsForDepartments +
 *     resolveProgress agree for the same department/status.
 *  3. A department with NO config row for a status: getActivityProgressFromStatus
 *     THROWS (never returns a number), and resolveProgress returns ok:false
 *     (never a number) — and a gap is logged in both cases.
 *  4. A DISABLED row: same as #3 — throws / ok:false, never the stored
 *     percentage value, and logs a gap.
 *  5. A departmentId:null (legacy) activity resolves against the app's
 *     default legacy department's real config, not an immediate gap.
 *  6. Creating an activity via the real write-path shape sets progress from
 *     its OWN department's config, not any other department's.
 *  7. Simulating the real write-path rejection (mirrors POST /api/activities
 *     and PATCH /api/activities/[id]): attempting to create/move an activity
 *     into a status with a configuration gap throws and the activity is
 *     NEVER created/updated with a fabricated value — proven by catching the
 *     error and asserting no row was written.
 *  8. Changing status always recomputes progress from the new status + same department.
 *  9. recalculateProjectRollup averages a project's activities' progress,
 *     live-resolved against CURRENT config (not the possibly-stale stored
 *     column) — and excludes (never zeroes) a gapped activity from the average.
 *
 * Usage: npx tsx scripts/test-activity-progress-from-status.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, ActivityStatus, ActivityPriority, ProjectStatus, Role } from "@prisma/client";
import {
  getActivityProgressFromStatus,
  getProgressConfigsForDepartments,
  resolveProgress,
  ActivityProgressConfigurationError,
  __resetReportedGapsForTests,
} from "@/lib/activities/activity-progress";
import { recalculateProjectRollup } from "@/lib/projects/progress-rollup";
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

const RUN_ID = Date.now();
const originalConsoleError = console.error;
let capturedErrors: string[] = [];
async function withCapturedGapLogs<T>(fn: () => Promise<T>): Promise<T> {
  capturedErrors = [];
  console.error = (...args: unknown[]) => {
    capturedErrors.push(args.map(String).join(" "));
  };
  try {
    return await fn();
  } finally {
    console.error = originalConsoleError;
  }
}

async function throws(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (err) {
    return err instanceof ActivityProgressConfigurationError;
  }
}

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  let itDept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let salesDept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let owner: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let project: Awaited<ReturnType<typeof prisma.project.create>> | undefined;
  const activityIds: string[] = [];
  const configIds: string[] = [];

  try {
    itDept = await prisma.department.create({ data: { name: `Test IT Dept ${RUN_ID}`, slug: `test-it-dept-${RUN_ID}` } });
    salesDept = await prisma.department.create({ data: { name: `Test Sales Dept ${RUN_ID}`, slug: `test-sales-dept-${RUN_ID}` } });
    owner = await prisma.user.create({ data: { email: `test-progress-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });

    console.log("Same status (TODO), different percentage per department — no cross-department leakage\n");
    const itTodo = await prisma.activityProgressConfig.create({ data: { departmentId: itDept.id, status: ActivityStatus.TODO, progressPercent: 0, sortOrder: 0 } });
    const itInProgress = await prisma.activityProgressConfig.create({ data: { departmentId: itDept.id, status: ActivityStatus.IN_PROGRESS, progressPercent: 50, sortOrder: 1 } });
    const itCompleted = await prisma.activityProgressConfig.create({ data: { departmentId: itDept.id, status: ActivityStatus.COMPLETED, progressPercent: 100, sortOrder: 2 } });
    const salesTodo = await prisma.activityProgressConfig.create({ data: { departmentId: salesDept.id, status: ActivityStatus.TODO, progressPercent: 10, sortOrder: 0 } });
    const salesInProgress = await prisma.activityProgressConfig.create({ data: { departmentId: salesDept.id, status: ActivityStatus.IN_PROGRESS, progressPercent: 60, sortOrder: 1 } });
    const salesCompleted = await prisma.activityProgressConfig.create({ data: { departmentId: salesDept.id, status: ActivityStatus.COMPLETED, progressPercent: 100, sortOrder: 2 } });
    configIds.push(itTodo.id, itInProgress.id, itCompleted.id, salesTodo.id, salesInProgress.id, salesCompleted.id);

    check("IT TODO resolves to 0%", (await getActivityProgressFromStatus(itDept.id, ActivityStatus.TODO)) === 0);
    check("Sales TODO resolves to 10% (different from IT's 0%, same status)", (await getActivityProgressFromStatus(salesDept.id, ActivityStatus.TODO)) === 10);
    check("IT IN_PROGRESS resolves to 50%", (await getActivityProgressFromStatus(itDept.id, ActivityStatus.IN_PROGRESS)) === 50);
    check("Sales IN_PROGRESS resolves to 60% (different from IT's 50%)", (await getActivityProgressFromStatus(salesDept.id, ActivityStatus.IN_PROGRESS)) === 60);

    console.log("\nBulk loader (getProgressConfigsForDepartments) agrees with the single-activity helper, per department\n");
    const bulkConfigs = await getProgressConfigsForDepartments([itDept.id, salesDept.id]);
    const itTodoResolution = resolveProgress(bulkConfigs, itDept.id, ActivityStatus.TODO);
    const salesTodoResolution = resolveProgress(bulkConfigs, salesDept.id, ActivityStatus.TODO);
    check("resolveProgress(bulk, IT, TODO) === {ok:true, percent:0}", itTodoResolution.ok === true && itTodoResolution.percent === 0);
    check("resolveProgress(bulk, Sales, TODO) === {ok:true, percent:10}", salesTodoResolution.ok === true && salesTodoResolution.percent === 10);

    console.log("\nA missing config row: getActivityProgressFromStatus THROWS (never returns a number), resolveProgress returns ok:false, and a gap is logged\n");
    __resetReportedGapsForTests();
    const missingThrew = await withCapturedGapLogs(() => throws(() => getActivityProgressFromStatus(itDept!.id, ActivityStatus.BLOCKED)));
    check("Missing BLOCKED config throws ActivityProgressConfigurationError (never returns a fabricated number)", missingThrew);
    check("A configuration gap was logged for the missing row", capturedErrors.some((e) => e.includes("configuration gap") && e.includes("BLOCKED")));
    const missingConfigMap = await getProgressConfigsForDepartments([itDept.id]);
    const missingResolution = resolveProgress(missingConfigMap, itDept.id, ActivityStatus.BLOCKED);
    check("resolveProgress for the same gap returns ok:false (never a number standing in for 'unknown')", missingResolution.ok === false);

    console.log("\nA DISABLED row: same treatment as missing — throws / ok:false, never the stored percentage, and logs a gap\n");
    const itOnHold = await prisma.activityProgressConfig.create({ data: { departmentId: itDept.id, status: ActivityStatus.ON_HOLD, progressPercent: 75, isEnabled: false, sortOrder: 3 } });
    configIds.push(itOnHold.id);
    __resetReportedGapsForTests();
    const disabledThrew = await withCapturedGapLogs(() => throws(() => getActivityProgressFromStatus(itDept!.id, ActivityStatus.ON_HOLD)));
    check("Disabled ON_HOLD row (stored 75%) throws instead of returning 75% or any other number", disabledThrew);
    check("A configuration gap was logged for the disabled row", capturedErrors.some((e) => e.includes("configuration gap") && e.includes("DISABLED")));
    const disabledConfigMap = await getProgressConfigsForDepartments([itDept.id]);
    const disabledResolution = resolveProgress(disabledConfigMap, itDept.id, ActivityStatus.ON_HOLD);
    check("resolveProgress for the disabled row returns ok:false", disabledResolution.ok === false && disabledResolution.reason === "disabled");

    console.log("\nA departmentId:null (legacy) activity resolves against the app's default legacy department's REAL config\n");
    const legacyDeptId = await getDefaultLegacyDepartmentId();
    if (legacyDeptId) {
      const legacyRow = await prisma.activityProgressConfig.findUnique({ where: { departmentId_status: { departmentId: legacyDeptId, status: ActivityStatus.COMPLETED } } });
      check("Legacy department has a real COMPLETED row to fall back to", legacyRow != null && legacyRow.isEnabled);
      if (legacyRow && legacyRow.isEnabled) {
        const legacyResult = await getActivityProgressFromStatus(null, ActivityStatus.COMPLETED);
        check("departmentId:null COMPLETED resolves to the legacy department's real percentage", legacyResult === legacyRow.progressPercent);
      }
    } else {
      console.log("  (no default legacy department configured in this environment — skipping legacy-fallback assertions)");
    }

    console.log("\nCreating an activity sets progress from its OWN department's config (mirrors POST /api/activities)\n");
    project = await prisma.project.create({ data: { title: `Test Progress Project ${RUN_ID}`, status: ProjectStatus.IN_PROGRESS, departmentId: itDept.id, ownerId: owner.id } });
    const created = await prisma.projectActivity.create({
      data: {
        title: `Test Progress Activity ${RUN_ID}`,
        status: ActivityStatus.IN_PROGRESS,
        priority: ActivityPriority.MEDIUM,
        departmentId: itDept.id,
        projectId: project.id,
        progress: await getActivityProgressFromStatus(itDept.id, ActivityStatus.IN_PROGRESS),
      },
    });
    activityIds.push(created.id);
    check("New IT IN_PROGRESS activity gets IT's 50%, not Sales' 60%", created.progress === 50);

    console.log("\nWrite-path rejection: attempting to compute progress for a gapped status throws BEFORE any row is written (mirrors POST/PATCH rejecting with configuration_required)\n");
    const activityCountBefore = await prisma.projectActivity.count({ where: { projectId: project.id } });
    let writeRejected = false;
    try {
      await prisma.projectActivity.create({
        data: {
          title: `Should never be created ${RUN_ID}`,
          status: ActivityStatus.BLOCKED,
          priority: ActivityPriority.MEDIUM,
          departmentId: itDept.id,
          projectId: project.id,
          progress: await getActivityProgressFromStatus(itDept.id, ActivityStatus.BLOCKED),
        },
      });
    } catch (err) {
      writeRejected = err instanceof ActivityProgressConfigurationError;
    }
    const activityCountAfter = await prisma.projectActivity.count({ where: { projectId: project.id } });
    check("Creating an activity with a gapped status throws and rejects the write", writeRejected);
    check("No activity row was actually created when the write was rejected", activityCountAfter === activityCountBefore);

    console.log("\nChanging status always recomputes progress from the new status + same department (mirrors PATCH /api/activities/[id])\n");
    const movedToTodo = await prisma.projectActivity.update({
      where: { id: created.id },
      data: { status: ActivityStatus.TODO, progress: await getActivityProgressFromStatus(itDept.id, ActivityStatus.TODO) },
    });
    check("Moving to TODO recomputes progress to IT's 0%", movedToTodo.progress === 0);

    console.log("\nrecalculateProjectRollup averages a project's activities' progress, live-resolved, excluding any gapped activity (never zeroing it)\n");
    const completedActivity = await prisma.projectActivity.update({
      where: { id: created.id },
      data: { isCompleted: true, status: ActivityStatus.COMPLETED, completedAt: new Date(), progress: await getActivityProgressFromStatus(itDept.id, ActivityStatus.COMPLETED) },
    });
    check("Mark Complete sets progress to IT's configured 100%", completedActivity.progress === 100);
    const secondActivity = await prisma.projectActivity.create({
      data: { title: `Test Progress Activity 2 ${RUN_ID}`, status: ActivityStatus.TODO, priority: ActivityPriority.MEDIUM, departmentId: itDept.id, projectId: project.id, progress: 0 },
    });
    activityIds.push(secondActivity.id);
    await recalculateProjectRollup(project.id);
    const projectAfterRollup = await prisma.project.findUnique({ where: { id: project.id }, select: { progress: true } });
    check("Project progress is the average of its activities' progress (100 + 0) / 2 = 50", projectAfterRollup?.progress === 50);

    // Third activity with a gapped status (bypassing the write-path guard via
    // direct prisma write, simulating pre-existing/legacy data) must be
    // EXCLUDED from the rollup average, never counted as 0%.
    const gappedActivity = await prisma.projectActivity.create({
      data: { title: `Test Progress Activity Gapped ${RUN_ID}`, status: ActivityStatus.BLOCKED, priority: ActivityPriority.MEDIUM, departmentId: itDept.id, projectId: project.id, progress: 0 },
    });
    activityIds.push(gappedActivity.id);
    __resetReportedGapsForTests();
    await withCapturedGapLogs(() => recalculateProjectRollup(project!.id));
    const projectAfterGappedRollup = await prisma.project.findUnique({ where: { id: project.id }, select: { progress: true } });
    check("Rollup excludes the gapped activity — average stays (100 + 0) / 2 = 50, NOT (100 + 0 + 0) / 3 = 33 (which would silently count the gap as 0%)", projectAfterGappedRollup?.progress === 50);
    check("Rollup logged that an activity was excluded due to a configuration gap", capturedErrors.some((e) => e.includes("progress-rollup") && e.includes("excluded")));
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["activities", () => (activityIds.length > 0 ? prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } }) : Promise.resolve())],
      ["project", () => (project ? prisma.project.deleteMany({ where: { id: project.id } }) : Promise.resolve())],
      ["activityProgressConfig", () => (configIds.length > 0 ? prisma.activityProgressConfig.deleteMany({ where: { id: { in: configIds } } }) : Promise.resolve())],
      ["user", () => (owner ? prisma.user.deleteMany({ where: { id: owner.id } }) : Promise.resolve())],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: [itDept?.id, salesDept?.id].filter((x): x is string => !!x) } } })],
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
