/**
 * Tests for lib/gantt-filters.ts — the extracted, shared search+status+
 * priority filtering rule the Project Gantt's Priority filter (Part 1) now
 * uses, side by side with the pre-existing Status filter. The pure-logic
 * section needs no DB/DOM: this is exactly the logic
 * components/gantt/gantt-chart.tsx calls from its filteredGroups useMemo.
 *
 * The second, DB-backed section (Part 2 corrective) proves the filter's
 * OPTIONS actually come from real department-scoped ActivityPriorityConfig
 * rows (lib/priority-config.ts) — two departments with genuinely different
 * enabled priorities/order/active-workspace, and a legacy/disabled-priority
 * record that stays visible without being newly selectable.
 *
 * Usage: npx tsx scripts/test-gantt-priority-filter.ts
 */
import { prisma } from "@/lib/prisma";
import { filterGanttGroups, type GanttFilterableGroup, type GanttFilterableItem } from "@/lib/gantt-filters";
import { projectPriorityKey, PROJECT_PRIORITY_LABEL } from "@/lib/project-priority";
import { ACTIVITY_PRIORITY_RANK, ACTIVITY_PRIORITY_LABEL } from "@/lib/activity-priority";
import { ActivityPriority, ActivityStatus, Role, AuthProvider } from "@prisma/client";
import { getActivityPriorityConfigsForDepartments, buildPriorityFilterOptions } from "@/lib/priority-config";

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

interface Item extends GanttFilterableItem {
  id: string;
}
interface Group extends GanttFilterableGroup<Item> {
  id: string;
}

const groups: Group[] = [
  {
    id: "p1", title: "Alpha Project", status: "IN_PROGRESS", priority: "HIGH",
    children: [
      { id: "a1", title: "Design review", status: "TODO", priority: "URGENT" },
      { id: "a2", title: "Implementation", status: "IN_PROGRESS", priority: "LOW" },
    ],
  },
  {
    id: "p2", title: "Beta Project", status: "ON_HOLD", priority: "LOW",
    children: [
      { id: "a3", title: "Research", status: "COMPLETED", priority: "MEDIUM" },
    ],
  },
  {
    id: "p3", title: "Gamma Project", status: "COMPLETED", priority: "MEDIUM",
    children: [],
  },
];

console.log("Testing Priority filter alone (Part 1)...\n");

{
  const result = filterGanttGroups(groups, "", "ALL", "URGENT");
  check("Only the group with a matching child survives (Alpha, via a1)", result.length === 1 && result[0].id === "p1");
  check("Alpha's children are pruned to only the URGENT one", result[0].children.length === 1 && result[0].children[0].id === "a1");
}

{
  // Beta's OWN group priority is LOW — it must survive even though its one
  // child (Research, MEDIUM) doesn't match, because the group itself matches.
  const result = filterGanttGroups(groups, "", "ALL", "LOW");
  const beta = result.find((g) => g.id === "p2");
  check("Beta survives via its OWN priority (LOW) matching, not a child", !!beta);
  check("Beta's non-matching child (Research, MEDIUM) is pruned away", beta ? beta.children.length === 0 : false);
  const alpha = result.find((g) => g.id === "p1");
  check("Alpha survives via its LOW child (Implementation)", !!alpha && alpha.children.length === 1 && alpha.children[0].id === "a2");
}

{
  const result = filterGanttGroups(groups, "", "ALL", "MEDIUM");
  check("Gamma (own priority MEDIUM, no children) survives on its own", result.some((g) => g.id === "p3"));
}

console.log("\nTesting Status + Priority combined (Part 1 + existing Status filter)...\n");

{
  // status=IN_PROGRESS AND priority=LOW should match ONLY a2 (Implementation).
  const result = filterGanttGroups(groups, "", "IN_PROGRESS", "LOW");
  check("Combined filter narrows to exactly the one matching group", result.length === 1 && result[0].id === "p1");
  check("Combined filter narrows to exactly the one matching child", result[0].children.length === 1 && result[0].children[0].id === "a2");
}

{
  // A combination matching nothing anywhere returns an empty result.
  const result = filterGanttGroups(groups, "", "COMPLETED", "URGENT");
  check("A combination matching nothing returns no groups", result.length === 0);
}

console.log("\nTesting search still composes with both filters (pre-existing behavior unaffected)...\n");

{
  const result = filterGanttGroups(groups, "design", "ALL", "ALL");
  check("Search alone still finds a1 (Design review) under Alpha", result.length === 1 && result[0].children.length === 1 && result[0].children[0].id === "a1");
}

{
  const result = filterGanttGroups(groups, "design", "ALL", "LOW");
  check("Search + Priority combined correctly matches nothing (Design review is URGENT, not LOW)", result.length === 0);
}

console.log("\nTesting ALL/ALL is a no-op (identical structure back out)...\n");
{
  const result = filterGanttGroups(groups, "", "ALL", "ALL");
  check("No filters active returns every group unpruned", result.length === 3 && result.every((g, i) => g.children.length === groups[i].children.length));
}

console.log("\nTesting lib/project-priority.ts's Int -> ActivityPriority key mapping...\n");
check("1 maps to LOW", projectPriorityKey(1) === ActivityPriority.LOW);
check("2 maps to MEDIUM", projectPriorityKey(2) === ActivityPriority.MEDIUM);
check("3 maps to HIGH", projectPriorityKey(3) === ActivityPriority.HIGH);
check("An out-of-range legacy value (e.g. 4) maps to null, never a wrong key", projectPriorityKey(4) === null);
check("PROJECT_PRIORITY_LABEL matches the same 1/2/3 scale used elsewhere in the app", PROJECT_PRIORITY_LABEL[1] === "Low" && PROJECT_PRIORITY_LABEL[2] === "Medium" && PROJECT_PRIORITY_LABEL[3] === "High");

console.log("\nTesting the Priority filter's option order follows the configured (canonical) order, not enum declaration order...\n");
const canonicalDesc = ([ActivityPriority.URGENT, ActivityPriority.HIGH, ActivityPriority.MEDIUM, ActivityPriority.LOW]);
check(
  "URGENT > HIGH > MEDIUM > LOW by ACTIVITY_PRIORITY_RANK — the exact order the filter's dropdown renders in",
  canonicalDesc.every((p, i) => i === 0 || ACTIVITY_PRIORITY_RANK[canonicalDesc[i - 1]] > ACTIVITY_PRIORITY_RANK[p])
);
check("Every canonical priority has a human label", canonicalDesc.every((p) => typeof ACTIVITY_PRIORITY_LABEL[p] === "string" && ACTIVITY_PRIORITY_LABEL[p].length > 0));

const RUN_ID = Date.now();

async function dbBackedScopedPrioritySection() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("\nNo reachable DATABASE_URL in this environment — skipping the DB-backed scoped-priority section.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  let deptA: { id: string } | undefined;
  let deptB: { id: string } | undefined;
  let owner: { id: string } | undefined;
  const projectIds: string[] = [];
  const activityIds: string[] = [];

  try {
    console.log("\nSetting up two departments with genuinely different priority configuration...\n");
    deptA = await prisma.department.create({ data: { name: `Gantt Priority Test A ${RUN_ID}`, slug: `gantt-priority-test-a-${RUN_ID}` } });
    deptB = await prisma.department.create({ data: { name: `Gantt Priority Test B ${RUN_ID}`, slug: `gantt-priority-test-b-${RUN_ID}` } });
    owner = await prisma.user.create({ data: { email: `gantt-priority-owner-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });

    // deptA ("active workspace" #1): standard urgency-first, all enabled.
    await prisma.activityPriorityConfig.createMany({
      data: [
        { departmentId: deptA.id, priority: ActivityPriority.URGENT, sortOrder: 0, isEnabled: true },
        { departmentId: deptA.id, priority: ActivityPriority.HIGH, sortOrder: 1, isEnabled: true },
        { departmentId: deptA.id, priority: ActivityPriority.MEDIUM, sortOrder: 2, isEnabled: true },
        { departmentId: deptA.id, priority: ActivityPriority.LOW, sortOrder: 3, isEnabled: true },
      ],
    });
    // deptB ("active workspace" #2): different order AND LOW disabled — a
    // genuinely different department configuration, not a re-application
    // of the same canonical order.
    await prisma.activityPriorityConfig.createMany({
      data: [
        { departmentId: deptB.id, priority: ActivityPriority.HIGH, sortOrder: 0, isEnabled: true },
        { departmentId: deptB.id, priority: ActivityPriority.URGENT, sortOrder: 1, isEnabled: true },
        { departmentId: deptB.id, priority: ActivityPriority.MEDIUM, sortOrder: 2, isEnabled: true },
        { departmentId: deptB.id, priority: ActivityPriority.LOW, sortOrder: 3, isEnabled: false },
      ],
    });

    const configMap = await getActivityPriorityConfigsForDepartments([deptA.id, deptB.id]);
    const optionsA = buildPriorityFilterOptions(configMap, deptA.id);
    const optionsB = buildPriorityFilterOptions(configMap, deptB.id);

    console.log("Testing the Gantt page's own resolution — different active workspace (department) genuinely changes the filter's options...\n");
    check("deptA's active-workspace Priority filter shows all 4, urgency-first", optionsA.map((o) => o.value).join(",") === "URGENT,HIGH,MEDIUM,LOW");
    check("deptB's active-workspace Priority filter shows HIGH first (its own configured order) and excludes LOW", optionsB.map((o) => o.value).join(",") === "HIGH,URGENT,MEDIUM");
    check("Switching active workspace between deptA and deptB genuinely changes what the filter offers", JSON.stringify(optionsA) !== JSON.stringify(optionsB));

    console.log("\nSetting up a legacy/disabled-priority record in deptB (a real ProjectActivity with priority=LOW, disabled there)...\n");
    const project = await prisma.project.create({ data: { title: `Gantt Priority Test Project ${RUN_ID}`, ownerId: owner.id, departmentId: deptB.id } });
    projectIds.push(project.id);
    const legacyActivity = await prisma.projectActivity.create({
      data: { title: `Legacy LOW Activity ${RUN_ID}`, projectId: project.id, departmentId: deptB.id, status: ActivityStatus.IN_PROGRESS, priority: ActivityPriority.LOW },
    });
    activityIds.push(legacyActivity.id);
    const reread = await prisma.projectActivity.findUniqueOrThrow({ where: { id: legacyActivity.id }, select: { priority: true } });

    console.log("Testing existing legacy/disabled-priority records stay visible without being offered as a NEW selectable value...\n");
    check("The activity itself still genuinely has priority=LOW in the database (disabling never mutates existing data)", reread.priority === "LOW");
    check("...but LOW is NOT among deptB's selectable filter options (buildPriorityFilterOptions excludes disabled)", !optionsB.some((o) => o.value === "LOW"));
    // filterGanttGroups itself is priority-agnostic about enablement — it
    // just matches whatever priorityFilter value the UI passes in. Since
    // the UI can never SELECT "LOW" for deptB (no such dropdown option),
    // this activity is simply unreachable via the Priority filter there —
    // but a Status-only or unfiltered view still shows it normally:
    const ganttGroup = { id: project.id, title: project.title, status: "PLANNING", priority: null, children: [{ id: legacyActivity.id, title: legacyActivity.title, status: "IN_PROGRESS", priority: "LOW" }] };
    const unfiltered = filterGanttGroups([ganttGroup], "", "ALL", "ALL");
    check("With no Priority filter active, the legacy LOW activity still renders normally (disabling ≠ hiding)", unfiltered[0].children.length === 1);

    console.log("\nTesting combined Status + Priority filtering using each department's OWN scoped options...\n");
    const activeStatusFilter = "IN_PROGRESS";
    const activePriorityFilterForB = optionsB[0].value; // HIGH — a real, currently-selectable option in deptB
    const combinedGroup = { id: project.id, title: project.title, status: "PLANNING", priority: null, children: [
      { id: legacyActivity.id, title: legacyActivity.title, status: "IN_PROGRESS", priority: "LOW" },
      { id: "hi-1", title: "A HIGH-priority activity", status: "IN_PROGRESS", priority: "HIGH" },
    ] };
    const combinedResult = filterGanttGroups([combinedGroup], "", activeStatusFilter, activePriorityFilterForB);
    check("Status=IN_PROGRESS + Priority=HIGH (deptB's own option) correctly matches only the HIGH activity, not the disabled-but-still-real LOW one", combinedResult[0].children.length === 1 && combinedResult[0].children[0].id === "hi-1");
  } finally {
    console.log("\nCleaning up test data...\n");
    const deptIds = [deptA?.id, deptB?.id].filter((x): x is string => !!x);
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["activities", () => (activityIds.length ? prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } }) : Promise.resolve())],
      ["projects", () => (projectIds.length ? prisma.project.deleteMany({ where: { id: { in: projectIds } } }) : Promise.resolve())],
      ["priority configs", () => (deptIds.length ? prisma.activityPriorityConfig.deleteMany({ where: { departmentId: { in: deptIds } } }) : Promise.resolve())],
      ["owner", () => (owner ? prisma.user.deleteMany({ where: { id: owner.id } }) : Promise.resolve())],
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

dbBackedScopedPrioritySection();
