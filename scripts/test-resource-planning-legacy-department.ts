/**
 * Regression: an activity with departmentId: null (predates department
 * scoping, or was created by a path that never set it — e.g. seed/import
 * data) has valid dates and real assignees, is visible everywhere else in
 * the app, but never appeared on the Resource Planning grid for the
 * department it should logically belong to.
 *
 * Root cause: every OTHER department-scoped list query in this app
 * (buildEntityListWhere, backing buildProjectListWhere/buildActivityListWhere/
 * ticket lists) folds a departmentId: null row into whichever department is
 * configured as the app's default legacy department
 * (getDefaultLegacyDepartmentId, DEFAULT_DEPARTMENT_SLUG env var — "IT
 * Department" by default) when that's the department currently being
 * viewed. getResourcePlanningEvents' Prisma query did a strict
 * `departmentId: departmentId` match with no such fallback, so a legacy
 * activity silently never matched.
 *
 * This test operates against whichever department DEFAULT_DEPARTMENT_SLUG
 * actually resolves to in this environment (not a throwaway fixture
 * department — the bug is specifically about THAT real department), since
 * the fallback only ever applies there. Skips cleanly if it isn't
 * configured/seeded in this environment.
 *
 * Tests:
 *  1. A departmentId: null activity with valid dates+assignee, viewed under
 *     the resolved legacy department, now appears in `events` (was
 *     previously invisible everywhere).
 *  2. The same activity does NOT appear when a DIFFERENT (non-legacy)
 *     department is queried — the fallback is scoped to the legacy
 *     department specifically, not a blanket "show every null-department
 *     row everywhere" leak.
 *  3. assignedUserIds output still correctly includes the real assignee for
 *     this legacy row (feeds getResourcePlanningResources' row
 *     reconciliation the same as any other activity).
 *
 * Usage: npx tsx scripts/test-resource-planning-legacy-department.ts
 * Requires a reachable DATABASE_URL AND a configured legacy department —
 * reports clearly and exits if either is missing.
 */
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, ActivityStatus, ActivityPriority } from "@prisma/client";
import { getDefaultLegacyDepartmentId } from "@/lib/services/department-service";
import { getResourcePlanningEvents } from "@/lib/services/resource-planning-service";

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

  const legacyDepartmentId = await getDefaultLegacyDepartmentId();
  if (!legacyDepartmentId) {
    console.log("No default legacy department configured/seeded in this environment (DEFAULT_DEPARTMENT_SLUG) — skipping.");
    printSummaryAndExit();
    return;
  }

  // A real department other than the legacy one, so test #2 has a
  // genuinely different department to confirm the fallback does NOT apply to.
  let otherDepartment: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let assignee: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let legacyActivity: Awaited<ReturnType<typeof prisma.projectActivity.create>> | undefined;

  try {
    otherDepartment = await prisma.department.create({
      data: { name: `RP Legacy Test Other Dept ${RUN_ID}`, slug: `rp-legacy-test-other-${RUN_ID}` },
    });
    assignee = await prisma.user.create({
      data: { email: `rp-legacy-assignee-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });

    const rangeStart = new Date("2026-07-20T00:00:00.000Z");
    const rangeEnd = new Date("2026-07-26T23:59:59.999Z");

    legacyActivity = await prisma.projectActivity.create({
      data: {
        title: `RP Legacy Activity ${RUN_ID}`,
        // departmentId intentionally omitted — reproduces the real-world
        // "departmentId: null" row this regression is about.
        status: ActivityStatus.IN_PROGRESS,
        priority: ActivityPriority.MEDIUM,
        startDate: new Date("2026-07-13T00:00:00.000Z"),
        dueDate: new Date("2026-07-31T00:00:00.000Z"),
        assignedUsers: { connect: [{ id: assignee.id }] },
      },
    });

    console.log(`\nTesting the departmentId: null activity is now visible under the resolved legacy department (${legacyDepartmentId})...\n`);
    const { events: legacyEvents, assignedUserIds: legacyAssignedUserIds } = await getResourcePlanningEvents({
      departmentId: legacyDepartmentId,
      rangeStart,
      rangeEnd,
    });
    const found = legacyEvents.find((e) => e.id === legacyActivity!.id);
    check("The legacy (departmentId: null) activity appears in `events` for the legacy department", !!found);
    check("Its real assignee is included in assignedUserIds", legacyAssignedUserIds.includes(assignee.id));

    console.log("\nTesting the fallback is scoped to the legacy department only, not a blanket leak...\n");
    const { events: otherDeptEvents } = await getResourcePlanningEvents({
      departmentId: otherDepartment.id,
      rangeStart,
      rangeEnd,
    });
    check("The same legacy activity does NOT appear under an unrelated department", !otherDeptEvents.some((e) => e.id === legacyActivity!.id));
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["activity", () => (legacyActivity ? prisma.projectActivity.deleteMany({ where: { id: legacyActivity.id } }) : Promise.resolve())],
      ["user", () => (assignee ? prisma.user.deleteMany({ where: { id: assignee.id } }) : Promise.resolve())],
      ["department", () => (otherDepartment ? prisma.department.deleteMany({ where: { id: otherDepartment.id } }) : Promise.resolve())],
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
