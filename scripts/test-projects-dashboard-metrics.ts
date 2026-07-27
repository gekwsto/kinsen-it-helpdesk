/**
 * getProjectsDashboardData (Part 3) — the Projects Dashboard's own service,
 * powering the "Projects" tab on the same /dashboard page. Verifies the
 * headline totals, by-status/by-priority/by-owner breakdowns, overdue
 * counts, and department isolation, all against real Prisma data (not
 * mocked) — proving the aggregate queries (count/groupBy) actually return
 * numbers that match reality, not just that they run without throwing.
 *
 * Tests:
 *  - Totals: totalProjects, activeProjects, completedProjects.
 *  - Overdue projects/activities counts.
 *  - Projects by status and by priority sum back to the correct totals.
 *  - Projects by owner attributes the right count to the right user.
 *  - Total/completed/overdue activities.
 *  - Department isolation: a second department's fixtures never leak into
 *    the first department's scoped dashboard call, and vice versa.
 *  - denied is returned for a department the caller has no access to.
 *
 * Usage: npx tsx scripts/test-projects-dashboard-metrics.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, ProjectStatus, ActivityStatus, ActivityPriority } from "@prisma/client";
import { getProjectsDashboardData } from "@/lib/services/projects-dashboard-service";
import { ensureStatusAndPriorityConfigForDepartment } from "@/lib/services/config-starter-data";
import { getProjectTerminalConfigsForDepartments, getActivityTerminalConfigsForDepartments, resolveProjectTerminal, resolveActivityTerminal } from "@/lib/status-terminal";
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
const YESTERDAY = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
const IN_FIVE_DAYS = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
const FAR_PAST = new Date("2020-01-01T00:00:00.000Z");

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
  let admin: { id: string } | undefined;
  let ownerA1: { id: string; email: string } | undefined;
  let ownerA2: { id: string; email: string } | undefined;
  const projectIds: string[] = [];
  const activityIds: string[] = [];

  try {
    deptA = await prisma.department.create({ data: { name: `Dash Metrics Test A ${RUN_ID}`, slug: `dash-metrics-test-a-${RUN_ID}` } });
    deptB = await prisma.department.create({ data: { name: `Dash Metrics Test B ${RUN_ID}`, slug: `dash-metrics-test-b-${RUN_ID}` } });
    // Full baseline terminal-status/priority config FIRST (same path
    // createDepartment() uses) — without this, every status in these test
    // departments would resolve to the new fail-safe (terminal=true),
    // silently breaking activeProjects/overdueProjects/etc. below.
    await ensureStatusAndPriorityConfigForDepartment(prisma, deptA.id);
    await ensureStatusAndPriorityConfigForDepartment(prisma, deptB.id);
    admin = await prisma.user.create({ data: { email: `dash-admin-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    ownerA1 = await prisma.user.create({ data: { email: `dash-owner-a1-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    ownerA2 = await prisma.user.create({ data: { email: `dash-owner-a2-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });

    console.log("\nCreating deptA fixtures: 4 projects, 3 activities...\n");
    const p1 = await prisma.project.create({ data: { title: `Dash Active Overdue ${RUN_ID}`, ownerId: ownerA1.id, departmentId: deptA.id, status: ProjectStatus.IN_PROGRESS, priority: 3, endDate: YESTERDAY, progress: 40 } });
    const p2 = await prisma.project.create({ data: { title: `Dash Completed Old ${RUN_ID}`, ownerId: ownerA1.id, departmentId: deptA.id, status: ProjectStatus.COMPLETED, priority: 2, endDate: FAR_PAST, progress: 100 } });
    const p3 = await prisma.project.create({ data: { title: `Dash Active DueSoon ${RUN_ID}`, ownerId: ownerA2.id, departmentId: deptA.id, status: ProjectStatus.PLANNING, priority: 1, endDate: IN_FIVE_DAYS, progress: 10 } });
    const p4 = await prisma.project.create({ data: { title: `Dash Active NoDate ${RUN_ID}`, ownerId: ownerA2.id, departmentId: deptA.id, status: ProjectStatus.IN_PROGRESS, priority: 3, endDate: null, progress: 0 } });
    projectIds.push(p1.id, p2.id, p3.id, p4.id);

    const a1 = await prisma.projectActivity.create({ data: { title: `Dash Overdue Activity ${RUN_ID}`, projectId: p1.id, departmentId: deptA.id, status: ActivityStatus.IN_PROGRESS, priority: ActivityPriority.HIGH, dueDate: YESTERDAY } });
    const a2 = await prisma.projectActivity.create({ data: { title: `Dash Completed Activity ${RUN_ID}`, projectId: p1.id, departmentId: deptA.id, status: ActivityStatus.COMPLETED, priority: ActivityPriority.LOW, dueDate: FAR_PAST } });
    const a3 = await prisma.projectActivity.create({ data: { title: `Dash Active Activity ${RUN_ID}`, projectId: p2.id, departmentId: deptA.id, status: ActivityStatus.TODO, priority: ActivityPriority.MEDIUM, dueDate: null } });
    const a4 = await prisma.projectActivity.create({ data: { title: `Dash Future DueDate Activity ${RUN_ID}`, projectId: p3.id, departmentId: deptA.id, status: ActivityStatus.IN_PROGRESS, priority: ActivityPriority.MEDIUM, dueDate: IN_FIVE_DAYS } });
    activityIds.push(a1.id, a2.id, a3.id, a4.id);

    console.log("Creating deptB fixtures (must never leak into deptA's numbers)...\n");
    const pB = await prisma.project.create({ data: { title: `Dash Other Dept Project ${RUN_ID}`, ownerId: ownerA1.id, departmentId: deptB.id, status: ProjectStatus.IN_PROGRESS, priority: 2, endDate: YESTERDAY } });
    projectIds.push(pB.id);
    const aB = await prisma.projectActivity.create({ data: { title: `Dash Other Dept Activity ${RUN_ID}`, projectId: pB.id, departmentId: deptB.id, status: ActivityStatus.IN_PROGRESS, priority: ActivityPriority.MEDIUM, dueDate: YESTERDAY } });
    activityIds.push(aB.id);

    console.log("Calling getProjectsDashboardData scoped to deptA...\n");
    const dataA = await getProjectsDashboardData(admin.id, Role.ADMIN, deptA.id);
    if ("denied" in dataA) {
      check("deptA call is not denied for an ADMIN user", false);
    } else {
      check("totalProjects === 4 (deptA only)", dataA.totalProjects === 4);
      check("activeProjects === 3 (p1, p3, p4 — p2 is COMPLETED/terminal)", dataA.activeProjects === 3);
      check("completedProjects === 1 (p2)", dataA.completedProjects === 1);
      check("overdueProjects === 1 (only p1 — active with a past endDate)", dataA.overdueProjects === 1);
      check("dueSoonProjects === 1 (only p3 — active, endDate within 7 days)", dataA.dueSoonProjects === 1);

      const statusTotal = dataA.byStatus.reduce((s, d) => s + d.value, 0);
      check("byStatus sums back to totalProjects", statusTotal === dataA.totalProjects);
      const inProgressEntry = dataA.byStatus.find((d) => d.name === "In Progress");
      check("byStatus has 2 In Progress projects (p1, p4)", !!inProgressEntry && inProgressEntry.value === 2);

      const priorityTotal = dataA.byPriority.reduce((s, d) => s + d.value, 0);
      check("byPriority sums back to totalProjects", priorityTotal === dataA.totalProjects);
      const highEntry = dataA.byPriority.find((d) => d.name === "High");
      check("byPriority has 2 High-priority projects (p1, p4)", !!highEntry && highEntry.value === 2);

      const owner1Entry = dataA.byOwner.find((d) => d.name === ownerA1!.email);
      const owner2Entry = dataA.byOwner.find((d) => d.name === ownerA2!.email);
      check("byOwner attributes 2 projects to ownerA1", !!owner1Entry && owner1Entry.count === 2);
      check("byOwner attributes 2 projects to ownerA2", !!owner2Entry && owner2Entry.count === 2);

      check("totalActivities === 4 (deptA only)", dataA.totalActivities === 4);
      check("completedActivities === 1 (a2)", dataA.completedActivities === 1);
      check("overdueActivities === 1 (a1 — active with a past dueDate; a2 is terminal despite its older dueDate; a4 has a FUTURE dueDate)", dataA.overdueActivities === 1);

      const recentIds = dataA.recentProjects.map((p) => p.id);
      check("recentProjects includes deptA's own projects", projectIds.slice(0, 4).every((id) => recentIds.includes(id)));
      check("recentProjects never includes deptB's project", !recentIds.includes(pB.id));
      const recentP1 = dataA.recentProjects.find((p) => p.id === p1.id);
      check("recentProjects correctly flags p1 as overdue", !!recentP1 && recentP1.overdue === true);
      const recentP2 = dataA.recentProjects.find((p) => p.id === p2.id);
      check("recentProjects correctly flags terminal p2 as NOT overdue despite its ancient endDate", !!recentP2 && recentP2.overdue === false);
      const recentP3 = dataA.recentProjects.find((p) => p.id === p3.id);
      check("recentProjects correctly flags p3 (non-terminal, FUTURE endDate) as NOT overdue", !!recentP3 && recentP3.overdue === false);
    }

    console.log("\nCross-checking dashboard overdue counts against direct per-row computation (the SAME logic Lists/Cards/Gantt use) for the identical fixtures...\n");
    {
      const [projectTerminalConfigs, activityTerminalConfigs] = await Promise.all([
        getProjectTerminalConfigsForDepartments([deptA.id]),
        getActivityTerminalConfigsForDepartments([deptA.id]),
      ]);
      const nowForCheck = new Date();
      const rawProjects = await prisma.project.findMany({ where: { departmentId: deptA.id }, select: { id: true, status: true, endDate: true, departmentId: true } });
      const rawActivities = await prisma.projectActivity.findMany({ where: { departmentId: deptA.id }, select: { id: true, status: true, dueDate: true, departmentId: true } });
      const listComputedOverdueProjects = rawProjects.filter((p) =>
        isProjectOverdue(p.endDate, resolveProjectTerminal(projectTerminalConfigs, p.departmentId, p.status), nowForCheck)
      ).length;
      const listComputedOverdueActivities = rawActivities.filter((a) =>
        isActivityOverdue(a.dueDate, resolveActivityTerminal(activityTerminalConfigs, a.departmentId, a.status), nowForCheck)
      ).length;
      check(
        "Dashboard overdueProjects count matches independently-computed per-row overdue count (list/card/Gantt logic) for the same department",
        !("denied" in dataA) && dataA.overdueProjects === listComputedOverdueProjects
      );
      check(
        "Dashboard overdueActivities count matches independently-computed per-row overdue count for the same department",
        !("denied" in dataA) && dataA.overdueActivities === listComputedOverdueActivities
      );
    }

    console.log("\nCalling getProjectsDashboardData scoped to deptB (isolation check)...\n");
    const dataB = await getProjectsDashboardData(admin.id, Role.ADMIN, deptB.id);
    if ("denied" in dataB) {
      check("deptB call is not denied for an ADMIN user", false);
    } else {
      check("deptB totalProjects === 1 (its own fixture only)", dataB.totalProjects === 1);
      check("deptB totalActivities === 1", dataB.totalActivities === 1);
      check("deptB overdueProjects === 1", dataB.overdueProjects === 1);
      const recentIdsB = dataB.recentProjects.map((p) => p.id);
      check("deptB's recentProjects never includes any of deptA's 4 projects", !projectIds.slice(0, 4).some((id) => recentIdsB.includes(id)));
    }

    console.log("\nTesting denied scoping for an invalid/inaccessible department id (non-Admin role, unrelated department)...\n");
    const regularUser = await prisma.user.create({ data: { email: `dash-regular-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    try {
      const deniedResult = await getProjectsDashboardData(regularUser.id, Role.USER, deptA.id);
      check("A regular user with no membership/permission anywhere in deptA is denied", "denied" in deniedResult);
    } finally {
      await prisma.user.deleteMany({ where: { id: regularUser.id } });
    }
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["activities", () => (activityIds.length ? prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } }) : Promise.resolve())],
      ["projects", () => (projectIds.length ? prisma.project.deleteMany({ where: { id: { in: projectIds } } }) : Promise.resolve())],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: [admin?.id, ownerA1?.id, ownerA2?.id].filter((x): x is string => !!x) } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: [deptA?.id, deptB?.id].filter((x): x is string => !!x) } } })],
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
