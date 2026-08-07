/**
 * Configuration-completeness health check (lib/services/config-health.ts) —
 * the single, central place that verifies a department's Activity Progress
 * + SLA configuration is actually complete and internally consistent,
 * wired into createDepartment(), prisma/seed.ts, and every relevant admin
 * mutation route (activity-progress PUT/POST/DELETE, priorities
 * POST/PATCH/DELETE, sla PUT/reset).
 *
 * Tests:
 *  1. A brand-new department created via createDepartment() is immediately
 *     healthy (proves the ensure*ForDepartment functions + the health check
 *     called inside that same transaction agree).
 *  2. A department with a real activity whose status has no
 *     ActivityProgressConfig row at all is reported unhealthy
 *     (activity_progress_missing).
 *  3. A department with a real activity whose status has a DISABLED config
 *     row is reported unhealthy (activity_progress_disabled_while_used) —
 *     proving the health check would catch it if the usage-analysis guard
 *     were ever bypassed (defense in depth, not redundant with it).
 *  4. An out-of-range progressPercent (defensively written directly via
 *     Prisma, bypassing the API's own validation) is reported unhealthy
 *     (activity_progress_invalid_percent).
 *  5. Two ActivityProgressConfig rows sharing the same sortOrder are
 *     reported unhealthy (activity_progress_sort_order_not_deterministic).
 *  6. An active SLA priority with no SlaPolicy row is reported unhealthy
 *     (sla_missing).
 *  7. Invalid (non-positive) SLA hours are reported unhealthy (sla_invalid_hours).
 *  8. A fully healthy department (real starter config, no activities using
 *     any status yet) reports healthy:true with zero issues.
 *  9. checkAllDepartmentsConfigHealth covers multiple departments
 *     independently (one unhealthy department doesn't mask another
 *     healthy one, or vice versa).
 *
 * Usage: npx tsx scripts/test-config-health.ts
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, ActivityStatus, ActivityPriority, ProjectStatus, Role } from "@prisma/client";
import { checkDepartmentConfigHealth, checkAllDepartmentsConfigHealth } from "@/lib/services/config-health";
import { createDepartment } from "@/lib/services/department-service";
import { ensureSlaPolicyForPriority, STARTER_SLA_HOURS } from "@/lib/services/config-starter-data";

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

function hasIssueType(issues: { type: string }[], type: string): boolean {
  return issues.some((i) => i.type === type);
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

  let newDept: Awaited<ReturnType<typeof createDepartment>> | undefined;
  let dirtyDept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let secondHealthyDept: Awaited<ReturnType<typeof createDepartment>> | undefined;
  let owner: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let project: Awaited<ReturnType<typeof prisma.project.create>> | undefined;
  const activityIds: string[] = [];

  try {
    console.log("A brand-new department (createDepartment) is immediately healthy\n");
    newDept = await createDepartment({ name: `Test Health New Dept ${RUN_ID}`, slug: `test-health-new-dept-${RUN_ID}` });
    const newDeptHealth = await checkDepartmentConfigHealth(prisma, newDept.id);
    check("New department reports healthy:true", newDeptHealth.healthy === true);
    check("New department has zero issues", newDeptHealth.issues.length === 0);

    console.log("\nBuilding a deliberately 'dirty' department to prove each issue type is actually detected\n");
    dirtyDept = await prisma.department.create({ data: { name: `Test Health Dirty Dept ${RUN_ID}`, slug: `test-health-dirty-dept-${RUN_ID}` } });
    owner = await prisma.user.create({ data: { email: `test-health-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    project = await prisma.project.create({ data: { title: `Test Health Project ${RUN_ID}`, status: ProjectStatus.IN_PROGRESS, departmentId: dirtyDept.id, ownerId: owner.id } });

    // Issue 1: an activity with a status that has NO config row at all.
    const missingStatusActivity = await prisma.projectActivity.create({
      data: { title: `Test Missing Status ${RUN_ID}`, status: ActivityStatus.TODO, priority: ActivityPriority.MEDIUM, departmentId: dirtyDept.id, projectId: project.id, progress: 0 },
    });
    activityIds.push(missingStatusActivity.id);

    const healthAfterMissing = await checkDepartmentConfigHealth(prisma, dirtyDept.id);
    check("Missing config for a used status is detected (activity_progress_missing)", hasIssueType(healthAfterMissing.issues, "activity_progress_missing"));
    check("Department is unhealthy", healthAfterMissing.healthy === false);

    // Issue 2: a DISABLED config row for a status an activity uses.
    await prisma.activityProgressConfig.create({ data: { departmentId: dirtyDept.id, status: ActivityStatus.IN_PROGRESS, progressPercent: 50, isEnabled: false, sortOrder: 0 } });
    const inProgressActivity = await prisma.projectActivity.create({
      data: { title: `Test Disabled-While-Used ${RUN_ID}`, status: ActivityStatus.IN_PROGRESS, priority: ActivityPriority.MEDIUM, departmentId: dirtyDept.id, projectId: project.id, progress: 0 },
    });
    activityIds.push(inProgressActivity.id);
    const healthAfterDisabledWhileUsed = await checkDepartmentConfigHealth(prisma, dirtyDept.id);
    check("A disabled-but-used config row is detected (activity_progress_disabled_while_used)", hasIssueType(healthAfterDisabledWhileUsed.issues, "activity_progress_disabled_while_used"));

    // Issue 3: an out-of-range percentage (bypassing API validation directly).
    await prisma.activityProgressConfig.create({ data: { departmentId: dirtyDept.id, status: ActivityStatus.BLOCKED, progressPercent: 150, isEnabled: true, sortOrder: 1 } });
    const healthAfterInvalidPercent = await checkDepartmentConfigHealth(prisma, dirtyDept.id);
    check("An out-of-range percentage is detected (activity_progress_invalid_percent)", hasIssueType(healthAfterInvalidPercent.issues, "activity_progress_invalid_percent"));

    // Issue 4: duplicate sortOrder.
    await prisma.activityProgressConfig.create({ data: { departmentId: dirtyDept.id, status: ActivityStatus.ON_HOLD, progressPercent: 50, isEnabled: true, sortOrder: 1 } });
    const healthAfterDuplicateSortOrder = await checkDepartmentConfigHealth(prisma, dirtyDept.id);
    check("A duplicate sortOrder is detected (activity_progress_sort_order_not_deterministic)", hasIssueType(healthAfterDuplicateSortOrder.issues, "activity_progress_sort_order_not_deterministic"));

    // Issue 5: an active priority with no SlaPolicy row.
    const priorityNoPolicy = await prisma.ticketPriority.create({ data: { departmentId: dirtyDept.id, name: `NoPolicy ${RUN_ID}`, level: 1, color: "#000", isActive: true } });
    const healthAfterMissingSla = await checkDepartmentConfigHealth(prisma, dirtyDept.id);
    check("An active priority with no SlaPolicy row is detected (sla_missing)", hasIssueType(healthAfterMissingSla.issues, "sla_missing"));

    // Issue 6: invalid SLA hours (0 hours, bypassing API validation).
    await ensureSlaPolicyForPriority(prisma, priorityNoPolicy.id);
    await prisma.slaPolicy.update({ where: { priorityId: priorityNoPolicy.id }, data: { firstResponseHours: 0, resolutionHours: 0 } });
    const healthAfterInvalidHours = await checkDepartmentConfigHealth(prisma, dirtyDept.id);
    check("Invalid (0) SLA hours are detected (sla_invalid_hours)", hasIssueType(healthAfterInvalidHours.issues, "sla_invalid_hours"));
    // sla_missing and sla_invalid_hours are mutually exclusive for the same
    // priority (once a policy row exists, "missing" no longer applies) — so
    // the running total is the 4 activity-progress issues + 1 sla issue = 5,
    // not 6, by this point. Each type was already individually verified above.
    check("Department accumulates all 5 still-applicable issues found so far", healthAfterInvalidHours.issues.length >= 5);

    console.log("\ncheckAllDepartmentsConfigHealth covers multiple departments independently\n");
    secondHealthyDept = await createDepartment({ name: `Test Health Second Healthy Dept ${RUN_ID}`, slug: `test-health-second-healthy-dept-${RUN_ID}` });
    const allResults = await checkAllDepartmentsConfigHealth(prisma, "test run");
    const dirtyResult = allResults.find((r) => r.departmentId === dirtyDept!.id);
    const healthyResult = allResults.find((r) => r.departmentId === secondHealthyDept!.id);
    check("The dirty department is reported unhealthy in the bulk check", dirtyResult?.healthy === false);
    check("The second healthy department is reported healthy in the SAME bulk check (no cross-department leakage of issues)", healthyResult?.healthy === true && (healthyResult?.issues.length ?? -1) === 0);
  } finally {
    const allDeptIds = [newDept?.id, dirtyDept?.id, secondHealthyDept?.id].filter((x): x is string => !!x);
    const priorityIds = allDeptIds.length > 0
      ? (await prisma.ticketPriority.findMany({ where: { departmentId: { in: allDeptIds } }, select: { id: true } })).map((p) => p.id)
      : [];
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["activities", () => (activityIds.length > 0 ? prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } }) : Promise.resolve())],
      ["project", () => (project ? prisma.project.deleteMany({ where: { id: project.id } }) : Promise.resolve())],
      ["priorities", () => (priorityIds.length > 0 ? prisma.ticketPriority.deleteMany({ where: { id: { in: priorityIds } } }) : Promise.resolve())],
      ["user", () => (owner ? prisma.user.deleteMany({ where: { id: owner.id } }) : Promise.resolve())],
      // newDept/secondHealthyDept were made via createDepartment(), which
      // also creates starter TicketStatus rows (onDelete: RESTRICT on
      // Department) — must be cleared first or the deletion below silently
      // fails, leaking every department in this batch (dirtyDept included,
      // since it's deleted in the same call).
      ["statuses", () => (allDeptIds.length > 0 ? prisma.ticketStatus.deleteMany({ where: { departmentId: { in: allDeptIds } } }) : Promise.resolve())],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: [newDept?.id, dirtyDept?.id, secondHealthyDept?.id].filter((x): x is string => !!x) } } })],
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
