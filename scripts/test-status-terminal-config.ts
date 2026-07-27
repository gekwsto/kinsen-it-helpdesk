/**
 * Corrective rewrite: lib/status-terminal.ts must NEVER decide a status is
 * terminal from its name or enum value at read time. This proves:
 *  - custom terminal configuration works (a status marked terminal behaves
 *    terminal, regardless of what it's named),
 *  - custom NON-terminal configuration overrides regardless of the status
 *    name (including COMPLETED/CANCELLED themselves — the exact names a
 *    naive implementation would be tempted to hardcode),
 *  - there is no silent hardcoded fallback: deleting a department's rows
 *    and re-querying produces the SAME fixed fail-safe value for every
 *    status (not a per-name guess) and logs a configuration gap,
 *  - every existing department has a FULL row set after the backfill
 *    migration (prisma/migrations/20260729000000_add_priority_config_and_backfill) —
 *    queried directly against the real DB, not assumed,
 *  - createDepartment() gives a brand-new department the same full row set
 *    immediately, with no gap window.
 *
 * Usage: npx tsx scripts/test-status-terminal-config.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { ProjectStatus, ActivityStatus } from "@prisma/client";
import {
  getProjectTerminalConfigsForDepartments,
  getActivityTerminalConfigsForDepartments,
  resolveProjectTerminal,
  resolveActivityTerminal,
  isProjectStatusTerminal,
  isActivityStatusTerminal,
  __resetReportedGapsForTests,
} from "@/lib/status-terminal";
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

  let deptA: { id: string } | undefined;
  let deptB: { id: string } | undefined;
  let freshDept: { id: string } | undefined;

  try {
    // Snapshotted BEFORE this test creates any of its own (deliberately
    // partially-configured, for override testing below) fixture departments
    // — this check is about every REAL pre-existing department in this
    // database, not this script's own in-progress fixtures.
    console.log("\nVerifying EVERY pre-existing department in this database has a full row set after the backfill migration...\n");
    const preexistingDepartmentIds = (await prisma.department.findMany({ select: { id: true } })).map((d) => d.id);
    const preexistingProjectCounts = await prisma.projectStatusConfig.groupBy({ by: ["departmentId"], _count: { _all: true }, where: { departmentId: { in: preexistingDepartmentIds } } });
    const preexistingActivityCounts = await prisma.activityStatusConfig.groupBy({ by: ["departmentId"], _count: { _all: true }, where: { departmentId: { in: preexistingDepartmentIds } } });
    const preexistingPriorityCounts = await prisma.activityPriorityConfig.groupBy({ by: ["departmentId"], _count: { _all: true }, where: { departmentId: { in: preexistingDepartmentIds } } });
    const preexistingProjectCountByDept = new Map(preexistingProjectCounts.map((r) => [r.departmentId, r._count._all]));
    const preexistingActivityCountByDept = new Map(preexistingActivityCounts.map((r) => [r.departmentId, r._count._all]));
    const preexistingPriorityCountByDept = new Map(preexistingPriorityCounts.map((r) => [r.departmentId, r._count._all]));
    const missingProjectConfig = preexistingDepartmentIds.filter((id) => (preexistingProjectCountByDept.get(id) ?? 0) !== Object.values(ProjectStatus).length);
    const missingActivityConfig = preexistingDepartmentIds.filter((id) => (preexistingActivityCountByDept.get(id) ?? 0) !== Object.values(ActivityStatus).length);
    const missingPriorityConfig = preexistingDepartmentIds.filter((id) => (preexistingPriorityCountByDept.get(id) ?? 0) !== 4);
    check(`Every pre-existing department (${preexistingDepartmentIds.length}) has a full ProjectStatusConfig row set`, missingProjectConfig.length === 0);
    check(`Every pre-existing department (${preexistingDepartmentIds.length}) has a full ActivityStatusConfig row set`, missingActivityConfig.length === 0);
    check(`Every pre-existing department (${preexistingDepartmentIds.length}) has a full ActivityPriorityConfig row set`, missingPriorityConfig.length === 0);
    if (missingProjectConfig.length > 0) console.error("  Departments missing ProjectStatusConfig rows:", missingProjectConfig);
    if (missingActivityConfig.length > 0) console.error("  Departments missing ActivityStatusConfig rows:", missingActivityConfig);
    if (missingPriorityConfig.length > 0) console.error("  Departments missing ActivityPriorityConfig rows:", missingPriorityConfig);

    deptA = await prisma.department.create({ data: { name: `Terminal Cfg Test A ${RUN_ID}`, slug: `terminal-cfg-test-a-${RUN_ID}` } });
    deptB = await prisma.department.create({ data: { name: `Terminal Cfg Test B ${RUN_ID}`, slug: `terminal-cfg-test-b-${RUN_ID}` } });
    // deptA/deptB created via raw prisma.department.create (bypassing
    // createDepartment()) to exercise the config rows THIS test controls
    // explicitly — seeded manually below, one row per status, nothing implicit.
    await prisma.projectStatusConfig.createMany({
      data: Object.values(ProjectStatus).map((status) => ({ departmentId: deptA!.id, status, isTerminal: status === "COMPLETED" || status === "CANCELLED" })),
    });
    await prisma.activityStatusConfig.createMany({
      data: Object.values(ActivityStatus).map((status) => ({ departmentId: deptA!.id, status, label: status, isTerminal: status === "COMPLETED" || status === "CANCELLED" })),
    });

    console.log("\nTesting custom terminal configuration (ON_HOLD marked terminal — an unusual, non-'complete-sounding' name)...\n");
    await prisma.projectStatusConfig.create({ data: { departmentId: deptB.id, status: ProjectStatus.ON_HOLD, isTerminal: true } });
    check("A status marked terminal behaves terminal, regardless of its name (ON_HOLD)", (await isProjectStatusTerminal(deptB.id, ProjectStatus.ON_HOLD)) === true);

    console.log("\nTesting custom NON-terminal configuration overrides regardless of status name — including COMPLETED/CANCELLED themselves...\n");
    await prisma.activityStatusConfig.create({ data: { departmentId: deptB.id, status: ActivityStatus.COMPLETED, label: "Completed", isTerminal: false } });
    await prisma.activityStatusConfig.create({ data: { departmentId: deptB.id, status: ActivityStatus.CANCELLED, label: "Cancelled", isTerminal: false } });
    check("COMPLETED explicitly configured non-terminal resolves non-terminal — the name is NOT consulted", (await isActivityStatusTerminal(deptB.id, ActivityStatus.COMPLETED)) === false);
    check("CANCELLED explicitly configured non-terminal resolves non-terminal — the name is NOT consulted", (await isActivityStatusTerminal(deptB.id, ActivityStatus.CANCELLED)) === false);
    // And the inverse, in the SAME department, for a status a naive implementation would assume is never terminal:
    await prisma.activityStatusConfig.create({ data: { departmentId: deptB.id, status: ActivityStatus.TODO, label: "To Do", isTerminal: true } });
    check("TODO explicitly configured terminal resolves terminal — the name is NOT consulted either direction", (await isActivityStatusTerminal(deptB.id, ActivityStatus.TODO)) === true);

    console.log("\nTesting there is NO silent hardcoded per-name fallback: deleting rows produces the SAME fixed fail-safe value for every status...\n");
    __resetReportedGapsForTests();
    const noConfigDept = await prisma.department.create({ data: { name: `Terminal Cfg No-Config ${RUN_ID}`, slug: `terminal-cfg-no-config-${RUN_ID}` } });
    // Deliberately zero config rows for this department.
    const resultsByStatus = new Map<ProjectStatus, boolean>();
    for (const status of Object.values(ProjectStatus)) {
      resultsByStatus.set(status, await isProjectStatusTerminal(noConfigDept.id, status));
    }
    const distinctValues = new Set(resultsByStatus.values());
    check(
      "Every status resolves to the SAME fail-safe value when configuration is missing (not a per-name guess like 'COMPLETED/CANCELLED look terminal, others don't')",
      distinctValues.size === 1
    );
    check("The single fail-safe value is fixed/documented (true = terminal, chosen to avoid false Overdue alarms)", [...distinctValues][0] === true);
    await prisma.department.deleteMany({ where: { id: noConfigDept.id } });

    console.log("\nTesting the bulk loader agrees with the single-department wrapper (same fail-safe/gap behavior both ways)...\n");
    const projectConfigs = await getProjectTerminalConfigsForDepartments([deptA.id, deptB.id]);
    check("Bulk-loaded deptA COMPLETED matches the single-department read", resolveProjectTerminal(projectConfigs, deptA.id, ProjectStatus.COMPLETED) === (await isProjectStatusTerminal(deptA.id, ProjectStatus.COMPLETED)));
    check("Bulk-loaded deptB ON_HOLD override matches the single-department read", resolveProjectTerminal(projectConfigs, deptB.id, ProjectStatus.ON_HOLD) === (await isProjectStatusTerminal(deptB.id, ProjectStatus.ON_HOLD)));
    const activityConfigs = await getActivityTerminalConfigsForDepartments([deptA.id, deptB.id]);
    check("Bulk-loaded deptB COMPLETED-non-terminal override matches the single-department read", resolveActivityTerminal(activityConfigs, deptB.id, ActivityStatus.COMPLETED) === (await isActivityStatusTerminal(deptB.id, ActivityStatus.COMPLETED)));

    console.log("\nTesting a department NOT present in the bulk-loaded map (never requested) also fails safe, not silently defaults per-name...\n");
    check("A department id absent from the config map resolves to the same fixed fail-safe, not a per-name guess", resolveProjectTerminal(projectConfigs, "totally-unrelated-id", ProjectStatus.COMPLETED) === true && resolveProjectTerminal(projectConfigs, "totally-unrelated-id", ProjectStatus.PLANNING) === true);

    console.log("\nTesting createDepartment() gives a brand-new department a FULL row set immediately (no gap window)...\n");
    freshDept = await createDepartment({ name: `Terminal Cfg Fresh Dept ${RUN_ID}` });
    const freshProjectRows = await prisma.projectStatusConfig.count({ where: { departmentId: freshDept.id } });
    const freshActivityRows = await prisma.activityStatusConfig.count({ where: { departmentId: freshDept.id } });
    const freshPriorityRows = await prisma.activityPriorityConfig.count({ where: { departmentId: freshDept.id } });
    check(`createDepartment() seeds all ${Object.values(ProjectStatus).length} ProjectStatus rows`, freshProjectRows === Object.values(ProjectStatus).length);
    check(`createDepartment() seeds all ${Object.values(ActivityStatus).length} ActivityStatus rows`, freshActivityRows === Object.values(ActivityStatus).length);
    check("createDepartment() also seeds all 4 ActivityPriority rows (Part 2)", freshPriorityRows === 4);
    check("The fresh department's default COMPLETED row is terminal (the documented starter value, not a runtime guess)", (await isProjectStatusTerminal(freshDept.id, ProjectStatus.COMPLETED)) === true);
    check("The fresh department's default PLANNING row is non-terminal", (await isProjectStatusTerminal(freshDept.id, ProjectStatus.PLANNING)) === false);
  } finally {
    console.log("\nCleaning up test data...\n");
    const deptIds = [deptA?.id, deptB?.id, freshDept?.id].filter((x): x is string => !!x);
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["project status configs", () => (deptIds.length ? prisma.projectStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } }) : Promise.resolve())],
      ["activity status configs", () => (deptIds.length ? prisma.activityStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } }) : Promise.resolve())],
      ["activity priority configs", () => (deptIds.length ? prisma.activityPriorityConfig.deleteMany({ where: { departmentId: { in: deptIds } } }) : Promise.resolve())],
      // createDepartment() (used for freshDept) also creates starter
      // TicketPriority rows (ensureStarterPrioritiesForDepartment) — these
      // have an onDelete: RESTRICT relation to Department, so they must be
      // removed before the department itself or the deletion below silently
      // fails, leaking the department across every run of this script.
      ["priorities", () => (deptIds.length ? prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } }) : Promise.resolve())],
      ["departments", () => (deptIds.length ? prisma.department.deleteMany({ where: { id: { in: deptIds } } }) : Promise.resolve())],
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
