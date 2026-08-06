/**
 * Verifies the Projects Dashboard's clickable KPI cards: Total/Active/
 * Completed/Overdue Projects each link to an All Projects URL whose result
 * count is IDENTICAL to the dashboard's own count — both paths share
 * lib/services/project-query-service.ts's terminal-status resolution, this
 * test proves that sharing holds end to end using the REAL
 * getProjectsDashboardData() function and the REAL All Projects page
 * function (never reimplementations of either). The 3 activity-count cards
 * (Total/Completed/Overdue Activities) are covered separately by
 * scripts/test-dashboard-activity-cards.ts — they now link to the real
 * canonical All Activities list (app/(main)/activities/page.tsx), not the
 * project list; see that file for their own count-consistency checks.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-dashboard-project-cards.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { Role, ProjectStatus } from "@prisma/client";
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

  // All dynamically imported (never statically at file top) so
  // mock.module("next/headers", ...) above is already registered before
  // department-scope-service.ts's transitive workspace-service.ts import
  // (next/headers's cookies()) is first resolved.
  const { getProjectsDashboardData } = await import("@/lib/services/projects-dashboard-service");
  const { default: ProjectsPage } = await import("@/app/(main)/projects/page");
  const { ProjectList } = await import("@/components/projects/project-list");

  const userIds: string[] = [];
  const departmentIds: string[] = [];
  const projectIds: string[] = [];

  try {
    const dept = await createDepartment({ name: `Dash Project Cards Dept ${RUN_ID}`, slug: `dash-project-cards-dept-${RUN_ID}` });
    departmentIds.push(dept.id);

    const owner = await prisma.user.create({ data: { email: `dash-project-owner-${RUN_ID}@example.com`, role: Role.ADMIN } });
    userIds.push(owner.id);

    const now = new Date();
    const past = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const future = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);

    // p1: active, not overdue. p2: active, overdue. p3: completed (terminal
    // -> never overdue despite a past date). p4: completed (terminal, no date).
    const p1 = await prisma.project.create({ data: { title: `Dash Card P1 ${RUN_ID}`, status: ProjectStatus.PLANNING, ownerId: owner.id, departmentId: dept.id, endDate: future } });
    const p2 = await prisma.project.create({ data: { title: `Dash Card P2 ${RUN_ID}`, status: ProjectStatus.IN_PROGRESS, ownerId: owner.id, departmentId: dept.id, endDate: past } });
    const p3 = await prisma.project.create({ data: { title: `Dash Card P3 ${RUN_ID}`, status: ProjectStatus.COMPLETED, ownerId: owner.id, departmentId: dept.id, endDate: past } });
    const p4 = await prisma.project.create({ data: { title: `Dash Card P4 ${RUN_ID}`, status: ProjectStatus.CANCELLED, ownerId: owner.id, departmentId: dept.id } });
    projectIds.push(p1.id, p2.id, p3.id, p4.id);

    currentSession = { user: { id: owner.id, role: Role.ADMIN, customRoleId: null } };
    currentCookieDepartmentId = dept.id;

    console.log("\nDashboard data (the real getProjectsDashboardData)...\n");
    const dashboardData = await getProjectsDashboardData(owner.id, Role.ADMIN, dept.id);
    if ("denied" in dashboardData) throw new Error("Unexpected denial computing dashboard data for fixture ADMIN user");
    check("Total Projects = 4", dashboardData.totalProjects === 4);
    check("Active = 2 (p1, p2 — non-terminal)", dashboardData.activeProjects === 2);
    check("Completed = 2 (p3, p4 — terminal)", dashboardData.completedProjects === 2);
    check("Overdue Projects = 1 (only p2 — p3 is past-due but terminal, never overdue)", dashboardData.overdueProjects === 1);

    const callList = async (params: Record<string, string>) => {
      const element = await ProjectsPage({ searchParams: Promise.resolve(params) });
      const [listEl] = findElementsByType(element, ProjectList);
      return (listEl?.props.projects as any[])?.map((p) => p.id) ?? [];
    };

    console.log("\nEach card's destination list result count matches the dashboard count...\n");
    const totalIds = await callList({});
    check("Total Projects card destination shows exactly 4 projects, matching the card", totalIds.length === dashboardData.totalProjects);

    const activeIds = await callList({ statusGroup: "active" });
    check("Active card destination shows exactly 2 projects, matching the card", activeIds.length === dashboardData.activeProjects);
    check("Active card destination is exactly {p1, p2}", activeIds.slice().sort().join(",") === [p1.id, p2.id].sort().join(","));

    const completedIds = await callList({ statusGroup: "completed" });
    check("Completed card destination shows exactly 2 projects, matching the card", completedIds.length === dashboardData.completedProjects);
    check("Completed card destination is exactly {p3, p4}", completedIds.slice().sort().join(",") === [p3.id, p4.id].sort().join(","));

    const overdueIds = await callList({ overdue: "true" });
    check("Overdue Projects card destination shows exactly 1 project, matching the card", overdueIds.length === dashboardData.overdueProjects);
    check("Overdue Projects card destination is exactly {p2}", overdueIds.join(",") === p2.id);

    console.log("\nCard structure and the deliberate activity-card exception...\n");
    const cardsSource = readFileSync(join(process.cwd(), "components/dashboard/projects-kpi-cards.tsx"), "utf-8");
    check("Total Projects card links to /projects", cardsSource.includes('href: "/projects", ariaLabel'));
    check("Active card links to ?statusGroup=active", cardsSource.includes('href: "/projects?statusGroup=active"'));
    check("Completed card links to ?statusGroup=completed", cardsSource.includes('href: "/projects?statusGroup=completed"'));
    check("Overdue Projects card links to ?overdue=true", cardsSource.includes('href: "/projects?overdue=true"'));
    // Activity cards now link to the real canonical All Activities list
    // (app/(main)/activities/page.tsx) — see scripts/test-dashboard-activity-cards.ts
    // and scripts/test-activity-filters.ts for their own href/count-consistency checks.
    check("Total Activities card links to /activities, not the project list", cardsSource.includes('href: "/activities"'));
    check("Completed Activities card links to ?statusGroup=completed on /activities", cardsSource.includes('href: "/activities?statusGroup=completed"'));
    check("Overdue Activities card links to ?overdue=true on /activities", cardsSource.includes('href: "/activities?overdue=true"'));
    check("Every clickable card has a focus-visible ring", cardsSource.includes("focus-visible:ring-2"));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
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
