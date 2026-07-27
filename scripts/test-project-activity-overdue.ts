/**
 * End-to-end overdue tests (Part 2) against real Project/ProjectActivity
 * rows, exercising the exact same building blocks the real pages use
 * (getProjectTerminalConfigsForDepartments/resolveProjectTerminal +
 * isProjectOverdue, and the Activity equivalents) — not a re-implementation.
 *
 * Corrective note: departments here are seeded via
 * ensureStatusAndPriorityConfigForDepartment (the SAME full-backfill path
 * createDepartment() uses) BEFORE any override is applied — under the new
 * fail-safe architecture (lib/status-terminal.ts), a department with zero
 * config rows resolves EVERY status to the fixed fail-safe (terminal),
 * which would silently break every "non-terminal + past date = overdue"
 * assertion below if the baseline row set weren't there first.
 *
 * Fixture matrix (both Project and ProjectActivity):
 *  - non-terminal + future dueDate -> NOT overdue
 *  - non-terminal + past dueDate -> overdue
 *  - terminal + past dueDate -> NEVER overdue, however old
 *  - no dueDate at all -> never overdue
 *  - a department-specific terminal override changes the outcome for an
 *    otherwise-identical status/date combination (proves the rule isn't
 *    keyed off status names)
 *
 * Usage: npx tsx scripts/test-project-activity-overdue.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, ProjectStatus, ActivityStatus, ActivityPriority } from "@prisma/client";
import { ensureStatusAndPriorityConfigForDepartment } from "@/lib/services/config-starter-data";
import {
  getProjectTerminalConfigsForDepartments,
  getActivityTerminalConfigsForDepartments,
  resolveProjectTerminal,
  resolveActivityTerminal,
} from "@/lib/status-terminal";
import { isProjectOverdue, isActivityOverdue } from "@/lib/overdue";

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
const NOW = new Date();
const FAR_PAST = new Date("2020-01-01T00:00:00.000Z");
const YESTERDAY = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
const IN_FIVE_DAYS = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);

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
  let owner: { id: string } | undefined;
  const projectIds: string[] = [];
  const activityIds: string[] = [];

  try {
    deptA = await prisma.department.create({ data: { name: `Overdue Test A ${RUN_ID}`, slug: `overdue-test-a-${RUN_ID}` } });
    deptB = await prisma.department.create({ data: { name: `Overdue Test B ${RUN_ID}`, slug: `overdue-test-b-${RUN_ID}` } });
    // Full baseline row set FIRST — same path createDepartment() uses —
    // before any department-specific override is layered on top.
    await ensureStatusAndPriorityConfigForDepartment(prisma, deptA.id);
    await ensureStatusAndPriorityConfigForDepartment(prisma, deptB.id);
    owner = await prisma.user.create({ data: { email: `overdue-owner-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });

    // deptB overrides CANCELLED (default terminal) to NON-terminal, and
    // ON_HOLD activities (default non-terminal) to terminal — the direct
    // proof that overdue is never keyed off hardcoded status names.
    await prisma.projectStatusConfig.update({ where: { departmentId_status: { departmentId: deptB.id, status: ProjectStatus.CANCELLED } }, data: { isTerminal: false } });
    await prisma.activityStatusConfig.update({ where: { departmentId_status: { departmentId: deptB.id, status: ActivityStatus.ON_HOLD } }, data: { isTerminal: true } });

    console.log("\nCreating Project fixtures...\n");
    const futureProject = await prisma.project.create({
      data: { title: `Future DueDate Project ${RUN_ID}`, ownerId: owner.id, departmentId: deptA.id, status: ProjectStatus.IN_PROGRESS, endDate: IN_FIVE_DAYS },
    });
    projectIds.push(futureProject.id);
    const overdueProject = await prisma.project.create({
      data: { title: `Overdue Project ${RUN_ID}`, ownerId: owner.id, departmentId: deptA.id, status: ProjectStatus.IN_PROGRESS, endDate: YESTERDAY },
    });
    projectIds.push(overdueProject.id);
    const terminalOldProject = await prisma.project.create({
      data: { title: `Terminal Old Project ${RUN_ID}`, ownerId: owner.id, departmentId: deptA.id, status: ProjectStatus.COMPLETED, endDate: FAR_PAST },
    });
    projectIds.push(terminalOldProject.id);
    const noEndDateProject = await prisma.project.create({
      data: { title: `No EndDate Project ${RUN_ID}`, ownerId: owner.id, departmentId: deptA.id, status: ProjectStatus.IN_PROGRESS, endDate: null },
    });
    projectIds.push(noEndDateProject.id);
    // deptB: CANCELLED but overridden non-terminal there, with a past endDate.
    const overriddenOverdueProject = await prisma.project.create({
      data: { title: `Overridden Overdue Project ${RUN_ID}`, ownerId: owner.id, departmentId: deptB.id, status: ProjectStatus.CANCELLED, endDate: YESTERDAY },
    });
    projectIds.push(overriddenOverdueProject.id);
    // The SAME status/date combination in deptA (no override, CANCELLED stays terminal by default).
    const defaultCancelledProject = await prisma.project.create({
      data: { title: `Default Cancelled Project ${RUN_ID}`, ownerId: owner.id, departmentId: deptA.id, status: ProjectStatus.CANCELLED, endDate: YESTERDAY },
    });
    projectIds.push(defaultCancelledProject.id);

    const projectTerminalConfigs = await getProjectTerminalConfigsForDepartments([deptA.id, deptB.id]);
    const evalProjectOverdue = (p: { endDate: Date | null; departmentId: string | null; status: ProjectStatus }) =>
      isProjectOverdue(p.endDate, resolveProjectTerminal(projectTerminalConfigs, p.departmentId, p.status), NOW);

    console.log("Testing Project overdue rules...\n");
    check("Non-terminal status + FUTURE endDate -> NOT overdue", !evalProjectOverdue(futureProject));
    check("Non-terminal status + past endDate -> overdue", evalProjectOverdue(overdueProject));
    check("Terminal status with a far-past endDate is NEVER overdue", !evalProjectOverdue(terminalOldProject));
    check("No endDate at all is never overdue, even with a non-terminal status", !evalProjectOverdue(noEndDateProject));
    check("A default-terminal status (CANCELLED) overridden to non-terminal IS overdue with a past date", evalProjectOverdue(overriddenOverdueProject));
    check("The SAME status/date, in a department WITHOUT the override, stays NOT overdue (isolation)", !evalProjectOverdue(defaultCancelledProject));

    console.log("\nCreating ProjectActivity fixtures...\n");
    const futureActivity = await prisma.projectActivity.create({
      data: { title: `Future DueDate Activity ${RUN_ID}`, departmentId: deptA.id, status: ActivityStatus.IN_PROGRESS, priority: ActivityPriority.MEDIUM, dueDate: IN_FIVE_DAYS },
    });
    activityIds.push(futureActivity.id);
    const overdueActivity = await prisma.projectActivity.create({
      data: { title: `Overdue Activity ${RUN_ID}`, departmentId: deptA.id, status: ActivityStatus.IN_PROGRESS, priority: ActivityPriority.MEDIUM, dueDate: YESTERDAY },
    });
    activityIds.push(overdueActivity.id);
    const terminalOldActivity = await prisma.projectActivity.create({
      data: { title: `Terminal Old Activity ${RUN_ID}`, departmentId: deptA.id, status: ActivityStatus.COMPLETED, priority: ActivityPriority.MEDIUM, dueDate: FAR_PAST },
    });
    activityIds.push(terminalOldActivity.id);
    const noDueDateActivity = await prisma.projectActivity.create({
      data: { title: `No DueDate Activity ${RUN_ID}`, departmentId: deptA.id, status: ActivityStatus.IN_PROGRESS, priority: ActivityPriority.MEDIUM, dueDate: null },
    });
    activityIds.push(noDueDateActivity.id);
    // deptB: ON_HOLD but overridden TERMINAL there, with a past dueDate -> must NOT be overdue.
    const overriddenTerminalActivity = await prisma.projectActivity.create({
      data: { title: `Overridden Terminal Activity ${RUN_ID}`, departmentId: deptB.id, status: ActivityStatus.ON_HOLD, priority: ActivityPriority.MEDIUM, dueDate: YESTERDAY },
    });
    activityIds.push(overriddenTerminalActivity.id);
    const defaultOnHoldActivity = await prisma.projectActivity.create({
      data: { title: `Default OnHold Activity ${RUN_ID}`, departmentId: deptA.id, status: ActivityStatus.ON_HOLD, priority: ActivityPriority.MEDIUM, dueDate: YESTERDAY },
    });
    activityIds.push(defaultOnHoldActivity.id);

    const activityTerminalConfigs = await getActivityTerminalConfigsForDepartments([deptA.id, deptB.id]);
    const evalActivityOverdue = (a: { dueDate: Date | null; departmentId: string | null; status: ActivityStatus }) =>
      isActivityOverdue(a.dueDate, resolveActivityTerminal(activityTerminalConfigs, a.departmentId, a.status), NOW);

    console.log("Testing Activity overdue rules...\n");
    check("Non-terminal status + FUTURE dueDate -> NOT overdue", !evalActivityOverdue(futureActivity));
    check("Non-terminal status + past dueDate -> overdue", evalActivityOverdue(overdueActivity));
    check("Terminal status with a far-past dueDate is NEVER overdue", !evalActivityOverdue(terminalOldActivity));
    check("No dueDate at all is never overdue, even with a non-terminal status", !evalActivityOverdue(noDueDateActivity));
    check("A default-non-terminal status (ON_HOLD) overridden to terminal is NEVER overdue even with a past date", !evalActivityOverdue(overriddenTerminalActivity));
    check("The SAME status/date, in a department WITHOUT the override, IS overdue (isolation)", evalActivityOverdue(defaultOnHoldActivity));

    console.log("\nCross-checking against a fresh DB re-read (not just in-memory objects)...\n");
    const rereadProjects = await prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, endDate: true, departmentId: true, status: true } });
    const rereadOverdueProject = rereadProjects.find((p) => p.id === overdueProject.id)!;
    check("A fresh read of the overdue project still evaluates overdue", evalProjectOverdue(rereadOverdueProject));
    const rereadFutureProject = rereadProjects.find((p) => p.id === futureProject.id)!;
    check("A fresh read of the future-due project still evaluates NOT overdue", !evalProjectOverdue(rereadFutureProject));
  } finally {
    console.log("\nCleaning up test data...\n");
    const deptIds = [deptA?.id, deptB?.id].filter((x): x is string => !!x);
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["activities", () => (activityIds.length ? prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } }) : Promise.resolve())],
      ["projects", () => (projectIds.length ? prisma.project.deleteMany({ where: { id: { in: projectIds } } }) : Promise.resolve())],
      ["project status configs", () => (deptIds.length ? prisma.projectStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } }) : Promise.resolve())],
      ["activity status configs", () => (deptIds.length ? prisma.activityStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } }) : Promise.resolve())],
      ["activity priority configs", () => (deptIds.length ? prisma.activityPriorityConfig.deleteMany({ where: { departmentId: { in: deptIds } } }) : Promise.resolve())],
      ["owner user", () => (owner ? prisma.user.deleteMany({ where: { id: owner.id } }) : Promise.resolve())],
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
