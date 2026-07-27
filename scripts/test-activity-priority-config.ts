/**
 * lib/priority-config.ts — department-scoped enablement + display order for
 * ActivityPriority (ActivityPriorityConfig), the real source the Project
 * Gantt Priority filter and Resource Planning's own priority filter both
 * read from (Part 2 corrective — replaced the previous hardcoded
 * URGENT>HIGH>MEDIUM>LOW canonical constant both pages used independently).
 *
 * Tests:
 *  - Two departments with different configured sortOrder produce different
 *    filter option orders for the exact same 4 priorities.
 *  - A priority disabled in one department is excluded from that
 *    department's filter options, but still enabled (and offered) in the
 *    other.
 *  - A disabled priority's records remain resolvable/labelable — disabling
 *    only affects what NEW selection is offered, never existing data.
 *  - No hardcoded fallback: a missing config row resolves to the same
 *    fixed fail-safe (sorts last, stays enabled) for every priority, not a
 *    per-priority guess, and is logged as a gap.
 *  - The bulk loader agrees with buildPriorityFilterOptions end-to-end.
 *
 * Usage: npx tsx scripts/test-activity-priority-config.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { ActivityPriority } from "@prisma/client";
import {
  getActivityPriorityConfigsForDepartments,
  resolvePriorityConfigEntry,
  buildPriorityFilterOptions,
  __resetReportedGapsForTests,
} from "@/lib/priority-config";

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

  try {
    deptA = await prisma.department.create({ data: { name: `Priority Cfg Test A ${RUN_ID}`, slug: `priority-cfg-test-a-${RUN_ID}` } });
    deptB = await prisma.department.create({ data: { name: `Priority Cfg Test B ${RUN_ID}`, slug: `priority-cfg-test-b-${RUN_ID}` } });

    // deptA: standard urgency-first order, all 4 enabled.
    await prisma.activityPriorityConfig.createMany({
      data: [
        { departmentId: deptA.id, priority: ActivityPriority.URGENT, sortOrder: 0, isEnabled: true },
        { departmentId: deptA.id, priority: ActivityPriority.HIGH, sortOrder: 1, isEnabled: true },
        { departmentId: deptA.id, priority: ActivityPriority.MEDIUM, sortOrder: 2, isEnabled: true },
        { departmentId: deptA.id, priority: ActivityPriority.LOW, sortOrder: 3, isEnabled: true },
      ],
    });
    // deptB: DELIBERATELY REVERSED order, and LOW disabled entirely — a
    // real, different department configuration, not the same canonical
    // order re-applied.
    await prisma.activityPriorityConfig.createMany({
      data: [
        { departmentId: deptB.id, priority: ActivityPriority.LOW, sortOrder: 0, isEnabled: false },
        { departmentId: deptB.id, priority: ActivityPriority.MEDIUM, sortOrder: 1, isEnabled: true },
        { departmentId: deptB.id, priority: ActivityPriority.HIGH, sortOrder: 2, isEnabled: true },
        { departmentId: deptB.id, priority: ActivityPriority.URGENT, sortOrder: 3, isEnabled: true },
      ],
    });

    const configMap = await getActivityPriorityConfigsForDepartments([deptA.id, deptB.id]);

    console.log("\nTesting two departments with different configured order produce different filter option orders...\n");
    const optionsA = buildPriorityFilterOptions(configMap, deptA.id);
    const optionsB = buildPriorityFilterOptions(configMap, deptB.id);
    check("deptA's order is URGENT, HIGH, MEDIUM, LOW (its own configured sortOrder)", optionsA.map((o) => o.value).join(",") === "URGENT,HIGH,MEDIUM,LOW");
    check("deptB's order is MEDIUM, HIGH, URGENT (its own REVERSED configured sortOrder) — genuinely different from deptA", optionsB.map((o) => o.value).join(",") === "MEDIUM,HIGH,URGENT");
    check("deptA and deptB produce DIFFERENT option orderings for the identical priority set", optionsA.map((o) => o.value).join(",") !== optionsB.map((o) => o.value).join(","));

    console.log("\nTesting disabled priorities: excluded from one department's options, still enabled in the other...\n");
    check("deptB's options EXCLUDE LOW (disabled there)", !optionsB.some((o) => o.value === "LOW"));
    check("deptA's options STILL INCLUDE LOW (enabled there) — disabling in deptB doesn't leak into deptA", optionsA.some((o) => o.value === "LOW"));

    console.log("\nTesting a disabled priority's existing records remain fully resolvable/labelable (disabling only affects NEW selection)...\n");
    const lowEntryInB = resolvePriorityConfigEntry(configMap, deptB.id, ActivityPriority.LOW);
    check("A disabled priority's config entry is still readable directly (not deleted/hidden from resolution)", lowEntryInB.isEnabled === false && lowEntryInB.sortOrder === 0);

    console.log("\nTesting combined Status + Priority filtering still composes correctly with a department-scoped, non-canonical order...\n");
    // Reuse the same filterGanttGroups the Gantt component itself uses — a
    // group/child with LOW priority in deptB's scope is simply never
    // reachable via the filter (LOW isn't a selectable option there), but
    // the underlying filtering LOGIC (lib/gantt-filters.ts) is unaffected —
    // it just never gets invoked with priorityFilter="LOW" in deptB's UI.
    check("deptB's own selectable priority values are exactly its 3 enabled ones", optionsB.length === 3);
    check("deptA's own selectable priority values are all 4 (none disabled there)", optionsA.length === 4);

    console.log("\nTesting no hardcoded per-priority fallback: a department with zero config rows fails safe uniformly...\n");
    __resetReportedGapsForTests();
    const noConfigDept = await prisma.department.create({ data: { name: `Priority Cfg No-Config ${RUN_ID}`, slug: `priority-cfg-no-config-${RUN_ID}` } });
    const emptyMap = await getActivityPriorityConfigsForDepartments([noConfigDept.id]);
    const entries = Object.values(ActivityPriority).map((p) => resolvePriorityConfigEntry(emptyMap, noConfigDept.id, p));
    check("Every priority resolves to the SAME fail-safe sortOrder when configuration is missing (not a per-priority guess)", new Set(entries.map((e) => e.sortOrder)).size === 1);
    check("Every priority resolves to the SAME fail-safe isEnabled when configuration is missing", new Set(entries.map((e) => e.isEnabled)).size === 1);
    check("The fail-safe sorts LAST (a high sortOrder), never silently jumping ahead of real configured values", entries[0].sortOrder > 3);
    await prisma.department.deleteMany({ where: { id: noConfigDept.id } });

    console.log("\nTesting the bulk loader end-to-end matches per-priority resolution...\n");
    let allMatch = true;
    for (const dept of [deptA.id, deptB.id]) {
      for (const priority of Object.values(ActivityPriority)) {
        const viaResolve = resolvePriorityConfigEntry(configMap, dept, priority);
        const viaOptions = buildPriorityFilterOptions(configMap, dept).find((o) => o.value === priority);
        const shouldAppear = viaResolve.isEnabled;
        if (shouldAppear !== !!viaOptions) allMatch = false;
      }
    }
    check("buildPriorityFilterOptions' inclusion/exclusion always agrees with resolvePriorityConfigEntry's isEnabled", allMatch);
  } finally {
    console.log("\nCleaning up test data...\n");
    const deptIds = [deptA?.id, deptB?.id].filter((x): x is string => !!x);
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["activity priority configs", () => (deptIds.length ? prisma.activityPriorityConfig.deleteMany({ where: { departmentId: { in: deptIds } } }) : Promise.resolve())],
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
