/**
 * Verifies the Projects Dashboard's Total/Completed/Overdue Activities KPI
 * cards: each card's destination All Activities URL must produce a result
 * count IDENTICAL to the dashboard's own count — both paths share
 * lib/services/activity-query-service.ts's terminal-status resolution. This
 * test proves that sharing holds end to end using the REAL
 * getProjectsDashboardData() function and the REAL All Activities page
 * function (never reimplementations of either).
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-dashboard-activity-cards.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
import { prisma } from "@/lib/prisma";
import { Role, ActivityStatus, ActivityPriority } from "@prisma/client";
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

let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
let currentCookieDepartmentId: string | null = null;

mock.module("@/lib/auth", {
  namedExports: {
    auth: async () => currentSession,
    handlers: {},
    signIn: async () => {},
    signOut: async () => {},
  },
});
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({
      get: (name: string) => (name === "active_department_id" && currentCookieDepartmentId ? { value: currentCookieDepartmentId } : undefined),
    }),
    headers: async () => new Headers(),
  },
});

function findElementsByType(node: any, type: any, results: any[] = []): any[] {
  if (node == null || typeof node !== "object") return results;
  if (node.type === type) results.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const c of children) findElementsByType(c, type, results);
  else if (children) findElementsByType(children, type, results);
  return results;
}

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  // Dynamically imported so mock.module("next/headers", ...) above is
  // already registered before department-scope-service.ts's transitive
  // workspace-service.ts import (next/headers's cookies()) first resolves.
  const { getProjectsDashboardData } = await import("@/lib/services/projects-dashboard-service");
  const { default: ActivitiesPage } = await import("@/app/(main)/activities/page");
  const { ActivityList } = await import("@/components/activities/activity-list");

  const userIds: string[] = [];
  const departmentIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];

  try {
    const dept = await createDepartment({ name: `Dash Activity Cards Dept ${RUN_ID}`, slug: `dash-activity-cards-dept-${RUN_ID}` });
    departmentIds.push(dept.id);

    const owner = await prisma.user.create({ data: { email: `dash-activity-owner-${RUN_ID}@example.com`, role: Role.ADMIN } });
    userIds.push(owner.id);

    const project = await prisma.project.create({ data: { title: `Dash Activity Cards Project ${RUN_ID}`, ownerId: owner.id, departmentId: dept.id } });
    projectIds.push(project.id);

    const now = new Date();
    const past = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const future = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);

    // a1: incomplete, not overdue. a2: incomplete, overdue. a3: completed
    // (terminal -> never overdue despite a past due date). a4: completed
    // (terminal, no due date at all).
    const a1 = await prisma.projectActivity.create({ data: { title: `Dash Card A1 ${RUN_ID}`, status: ActivityStatus.TODO, priority: ActivityPriority.MEDIUM, projectId: project.id, departmentId: dept.id, dueDate: future } });
    const a2 = await prisma.projectActivity.create({ data: { title: `Dash Card A2 ${RUN_ID}`, status: ActivityStatus.IN_PROGRESS, priority: ActivityPriority.MEDIUM, projectId: project.id, departmentId: dept.id, dueDate: past } });
    const a3 = await prisma.projectActivity.create({ data: { title: `Dash Card A3 ${RUN_ID}`, status: ActivityStatus.COMPLETED, priority: ActivityPriority.MEDIUM, projectId: project.id, departmentId: dept.id, dueDate: past } });
    const a4 = await prisma.projectActivity.create({ data: { title: `Dash Card A4 ${RUN_ID}`, status: ActivityStatus.CANCELLED, priority: ActivityPriority.MEDIUM, projectId: project.id, departmentId: dept.id } });
    activityIds.push(a1.id, a2.id, a3.id, a4.id);

    currentSession = { user: { id: owner.id, role: Role.ADMIN, customRoleId: null } };
    currentCookieDepartmentId = dept.id;

    console.log("\nDashboard data (the real getProjectsDashboardData)...\n");
    const dashboardData = await getProjectsDashboardData(owner.id, Role.ADMIN, dept.id);
    if ("denied" in dashboardData) throw new Error("Unexpected denial computing dashboard data for fixture ADMIN user");
    check("Total Activities = 4", dashboardData.totalActivities === 4);
    check("Completed Activities = 2 (a3, a4 — terminal)", dashboardData.completedActivities === 2);
    check("Overdue Activities = 1 (only a2 — a3 is past-due but terminal, never overdue)", dashboardData.overdueActivities === 1);

    const callList = async (params: Record<string, string>) => {
      const element = await ActivitiesPage({ searchParams: Promise.resolve(params) });
      const [listEl] = findElementsByType(element, ActivityList);
      return (listEl?.props.activities as any[])?.map((a) => a.id) ?? [];
    };

    console.log("\nEach card's destination list result count matches the dashboard count (item 5, 6)...\n");
    const totalIds = await callList({});
    check("Total Activities card destination shows exactly 4 activities, matching the card", totalIds.length === dashboardData.totalActivities);

    const completedIds = await callList({ statusGroup: "completed" });
    check("Completed Activities card destination shows exactly 2 activities, matching the card", completedIds.length === dashboardData.completedActivities);
    check("Completed Activities card destination is exactly {a3, a4}", completedIds.slice().sort().join(",") === [a3.id, a4.id].sort().join(","));

    const overdueIds = await callList({ overdue: "true" });
    check("Overdue Activities card destination shows exactly 1 activity, matching the card", overdueIds.length === dashboardData.overdueActivities);
    check("Overdue Activities card destination is exactly {a2}", overdueIds.join(",") === a2.id);
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
