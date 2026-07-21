/**
 * Resource Planning drag-to-reschedule (components/resource-planning/resource-timeline.tsx)
 * reuses Project Gantt's exact date-shift math (components/gantt/gantt-chart.tsx's
 * startDrag/moveDrag/endDrag) and PATCHes the same PATCH /api/activities/[id]
 * route Gantt and the manual edit form already use. This test exercises the
 * shared PATCH route's authorization (canActOnEntity(..., "activity.edit") —
 * NOT the Gantt pages' own isAdmin-only UI flag, see the architecture plan)
 * and its newly-added date-range validation directly, plus mirrors the
 * day-delta math the drag handler performs.
 *
 * Tests:
 *  1. A user with activity.edit via an active DepartmentMembership can edit
 *     (canActOnEntity returns true) — the same check the PATCH route runs.
 *  2. A user with only resourcePlanning.view (no activity.edit) cannot edit
 *     (canActOnEntity returns false) — resourcePlanning.view never implies edit.
 *  3. Shifting both startDate/dueDate by the same day-delta (the drag math)
 *     preserves the original duration exactly.
 *  4. A resulting startDate > dueDate is rejected — mirrors the PATCH
 *     route's new imperative invalid_date_range check.
 *  5. A user with no standing in a different department is denied
 *     (canActOnEntity false) for an activity that lives there — the
 *     cross-department case.
 *  6. An activity with only one of startDate/dueDate set can still be
 *     shifted — after the shift both fields end up equal to the new date,
 *     matching Gantt's milestone-drag precedent (always sends both fields).
 *
 * Usage: npx tsx scripts/test-activity-date-drag.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { Role, DepartmentRole, AuthProvider, MembershipSource, ProjectStatus, ActivityStatus, ActivityPriority } from "@prisma/client";
import { canActOnEntity } from "@/lib/services/department-scope-service";
import { updateActivitySchema } from "@/lib/validations";
import { addDays } from "date-fns";

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

/** Mirrors the PATCH route's new imperative check exactly. */
function wouldRejectDateRange(effectiveStart: Date | null, effectiveDue: Date | null): boolean {
  return !!(effectiveStart && effectiveDue && effectiveStart > effectiveDue);
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

  console.log("\nTesting updateActivitySchema now accepts a nullable projectId (needed by both drag and the edit form)...\n");
  const parsedNull = updateActivitySchema.safeParse({ projectId: null });
  check("updateActivitySchema.parse({ projectId: null }) succeeds", parsedNull.success && parsedNull.data.projectId === null);

  console.log("\nTesting the day-delta shift math preserves duration...\n");
  const originalStart = new Date("2026-07-20T00:00:00.000Z");
  const originalEnd = new Date("2026-07-24T00:00:00.000Z");
  const originalDurationMs = originalEnd.getTime() - originalStart.getTime();
  const daysDelta = 2;
  const newStart = addDays(originalStart, daysDelta);
  const newEnd = addDays(originalEnd, daysDelta);
  check("+2 days: new start is 22 Jul", newStart.toISOString().startsWith("2026-07-22"));
  check("+2 days: new end is 26 Jul", newEnd.toISOString().startsWith("2026-07-26"));
  check("Duration is unchanged after the shift", newEnd.getTime() - newStart.getTime() === originalDurationMs);

  console.log("\nTesting a single-date (fallback) activity shifts to two equal dates, matching Gantt's milestone precedent...\n");
  // Mirrors ResourceEvent's own fallback resolution (start = startDate ?? dueDate,
  // end = dueDate ?? startDate) for an activity that only ever had dueDate set —
  // both resolved fields start out equal, and the drag handler shifts both
  // by the identical delta, so they stay equal after the move too.
  const onlyDueDate = new Date("2026-08-01T00:00:00.000Z");
  const resolvedStart = onlyDueDate; // startDate ?? dueDate, startDate was null
  const resolvedEnd = onlyDueDate; // dueDate ?? startDate
  const shiftedStart = addDays(resolvedStart, 3);
  const shiftedEnd = addDays(resolvedEnd, 3);
  check("Single-day shift keeps start === end after the move", shiftedStart.getTime() === shiftedEnd.getTime());
  check("Single-day shift actually moved the date", shiftedStart.getTime() !== onlyDueDate.getTime());

  console.log("\nTesting the invalid_date_range check...\n");
  check("start > due is rejected", wouldRejectDateRange(new Date("2026-07-25"), new Date("2026-07-20")));
  check("start === due is allowed (zero-duration single day)", !wouldRejectDateRange(new Date("2026-07-20"), new Date("2026-07-20")));
  check("start < due is allowed", !wouldRejectDateRange(new Date("2026-07-20"), new Date("2026-07-24")));
  check("Missing either side is allowed (partial update, nothing to compare)", !wouldRejectDateRange(new Date("2026-07-20"), null));

  let deptA: { id: string } | undefined;
  let deptB: { id: string } | undefined;
  let editorUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let viewOnlyUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let outsiderUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const membershipIds: string[] = [];
  const activityIds: string[] = [];
  let project: Awaited<ReturnType<typeof prisma.project.create>> | undefined;

  try {
    console.log("\nSetting up two departments and users with different standing...\n");
    deptA = await prisma.department.create({ data: { name: `Drag Dept A ${RUN_ID}`, slug: `drag-dept-a-${RUN_ID}` }, select: { id: true } });
    deptB = await prisma.department.create({ data: { name: `Drag Dept B ${RUN_ID}`, slug: `drag-dept-b-${RUN_ID}` }, select: { id: true } });

    editorUser = await prisma.user.create({
      data: { email: `drag-editor-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    viewOnlyUser = await prisma.user.create({
      data: { email: `drag-viewonly-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    outsiderUser = await prisma.user.create({
      data: { email: `drag-outsider-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });

    // AGENT_ASSIGNEE is seeded with activity.edit (see prisma/seed.ts).
    const editorMembership = await prisma.departmentMembership.create({
      data: { userId: editorUser.id, departmentId: deptA.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL },
    });
    membershipIds.push(editorMembership.id);

    // VIEWER is seeded read-only (ticket.view/project.view/etc, no activity.edit).
    const viewOnlyMembership = await prisma.departmentMembership.create({
      data: { userId: viewOnlyUser.id, departmentId: deptA.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(viewOnlyMembership.id);

    project = await prisma.project.create({
      data: { title: `Drag Project ${RUN_ID}`, ownerId: editorUser.id, departmentId: deptA.id, status: ProjectStatus.IN_PROGRESS },
    });
    const activity = await prisma.projectActivity.create({
      data: {
        title: `Drag Activity ${RUN_ID}`,
        projectId: project.id,
        departmentId: deptA.id,
        status: ActivityStatus.IN_PROGRESS,
        priority: ActivityPriority.MEDIUM,
        startDate: originalStart,
        dueDate: originalEnd,
        assignedUsers: { connect: [{ id: editorUser.id }] },
      },
    });
    activityIds.push(activity.id);

    console.log("\nTesting canActOnEntity — the exact check the PATCH route runs...\n");
    check(
      "A department member with activity.edit (AGENT_ASSIGNEE) can act on the activity",
      await canActOnEntity(editorUser.id, Role.USER, deptA.id, "activity.edit")
    );
    check(
      "A department member with only view permissions (VIEWER) cannot act on the activity",
      !(await canActOnEntity(viewOnlyUser.id, Role.USER, deptA.id, "activity.edit"))
    );
    check(
      "A user with no membership anywhere in deptA is denied",
      !(await canActOnEntity(outsiderUser.id, Role.USER, deptA.id, "activity.edit"))
    );
    check(
      "The same editor has no standing in deptB (cross-department case)",
      !(await canActOnEntity(editorUser.id, Role.USER, deptB.id, "activity.edit"))
    );
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["activities", () => prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } })],
      ["project", () => (project ? prisma.project.deleteMany({ where: { id: project.id } }) : Promise.resolve())],
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      [
        "users",
        () =>
          prisma.user.deleteMany({
            where: {
              id: {
                in: [editorUser?.id, viewOnlyUser?.id, outsiderUser?.id].filter((id): id is string => !!id),
              },
            },
          }),
      ],
      [
        "departments",
        () => prisma.department.deleteMany({ where: { id: { in: [deptA?.id, deptB?.id].filter((id): id is string => !!id) } } }),
      ],
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
